/**
 * voiceRelay.ts — the per-connection state machine.
 *
 * One instance per ESP32 device WS upgrade. Lifecycle:
 *   1. open upstream WS to StepFun with our `Bearer ${STEP_API_KEY}`
 *   2. expect `session.created` (an idle hello) and forward
 *      `session.ready` back to the device as a text frame
 *   3. loop:
 *        binary in (WFLV)  → strip header → base64 → `input_audio_buffer.append`
 *        text in (control) → forward + maybe rewrite `session.update` model
 *        binary up        → wrap in WFLV → device
 *        text up          → forward OR intercept function_call_arguments.done
 *
 * The transport is `ws` from npm; Bun's native WebSocket has different
 * message framing than `ws` which is what StepFun's docs expect on the
 * Node side, so we keep the toolchain explicit and predictable.
 */

import { WebSocket as NodeWebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  encodeWflvAudio,
  decodeWflvAudio,
  isLastChunk,
  isStreaming,
} from './frameIo.ts';
import { log } from './logger.ts';
import {
  ALLOWED_VOICES,
  DOWLINK_DEFAULT_SAMPLE_RATE_HZ,
  PROXY_SUBPROTOCOL,
  UPLINK_SAMPLE_RATE_HZ,
  makeError,
  type DeviceContext,
  type RelayErrorPayload,
} from './types.ts';
import {
  executeToolOverHttp,
  injectToolResult,
  type ToolCallArgs,
} from './toolInterceptor.ts';
import { applyAiToolSessionConfig } from './sessionConfig.ts';

type DeviceWs = {
  send(data: string | Buffer | Uint8Array, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(
    event: 'message',
    cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void
  ): unknown;
  on(event: 'close', cb: (code: number, reason: string) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'ping', cb: (data: Buffer) => void): unknown;
  ping(): void;
  readyState: number;
};

export type { DeviceWs };

const UPSTREAM_OPEN_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const DEVICE_IDLE_TIMEOUT_MS = 120_000;

// [diag] Event loop lag monitor. Distinguishes "StepFun sends audio.delta
// slowly (244-458ms gaps)" from "cloud event loop is blocked (drain /
// deviceWs.send backpressure / log IO)". If p99 lag is low but audio.delta
// gaps are large -> StepFun is the bottleneck (connection-layer issue).
// If p99 lag tracks the gaps -> cloud is the bottleneck (fix drain/send/log).
const eventLoopDelay = monitorEventLoopDelay();
eventLoopDelay.enable();
let lastEventLoopLogMs = 0;
setInterval(() => {
  const now = Date.now();
  if (now - lastEventLoopLogMs < 5000) return;
  lastEventLoopLogMs = now;
  const nsToMs = (value: number) => value / 1_000_000;
  log.info('event loop lag ms', {
    p50: Number(nsToMs(eventLoopDelay.percentile(50)).toFixed(2)),
    p90: Number(nsToMs(eventLoopDelay.percentile(90)).toFixed(2)),
    p99: Number(nsToMs(eventLoopDelay.percentile(99)).toFixed(2)),
    max: Number(nsToMs(eventLoopDelay.percentile(100)).toFixed(2)),
  });
  eventLoopDelay.reset();
}, 1000);

// [stepfun-fix] Do NOT send a subprotocol to StepFun's realtime upstream.
// The ws library errors "Server sent no subprotocol" if we request one and
// StepFun doesn't echo it (it doesn't). The official Step-Realtime-Console
// demo also sends no subprotocol.

interface UpstreamConfig {
  url: string;
  apiKey: string;
  model: string;
}

export interface RelayConfig {
  bind: string;
  port: number;
  upstream: UpstreamConfig;
  executeToolUrl: string;
  proxySecret: string;
  realtimeEnabled: boolean;
}

export async function handleConnection(
  deviceWs: DeviceWs,
  device: DeviceContext,
  req: IncomingMessage,
  config: RelayConfig
): Promise<void> {
  if (!config.realtimeEnabled) {
    sendErrorAndClose(
      deviceWs,
      makeError('disabled', 'Flash realtime disabled')
    );
    return;
  }

  // 1. Subprotocol gate. ESP32 always sends `wqn-flash-v2`; if anything
  //    else shows up, we treat it as a protocol mismatch (7001-ish).
  const devProto = req.headers['sec-websocket-protocol'];
  if (
    devProto &&
    !devProto
      .split(',')
      .map(s => s.trim())
      .includes(PROXY_SUBPROTOCOL)
  ) {
    sendErrorAndClose(
      deviceWs,
      makeError('protocol_mismatch', `expected ${PROXY_SUBPROTOCOL}`)
    );
    return;
  }

  // 2. Open upstream to StepFun. We also gate on its open handshake
  //    so a 401 here collapses the device link with a clear error.
  // [stepfun-fix] StepFun's realtime endpoint expects the model as a URL
  // query param (?model=...), matching the official Step-Realtime-Console
  // demo and OpenAI's realtime convention. Without it the upstream rejects
  // the session even with a valid key. Append it if not already present.
  let upstreamUrl = config.upstream.url;
  if (!upstreamUrl.includes('model=')) {
    upstreamUrl +=
      (upstreamUrl.includes('?') ? '&' : '?') +
      `model=${config.upstream.model}`;
  }
  const upstream = new NodeWebSocket(upstreamUrl, undefined, {
    handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
    perMessageDeflate: false,
    headers: {
      authorization: `Bearer ${config.upstream.apiKey}`,
      'X-WQN-Internal': `device=${device.deviceId};user=${device.userId}`,
    },
  });
  // [tts-speed-fix] TCP_NODELAY on the upstream socket: disable Nagle so small
  // audio.delta frames aren't coalesced (best-effort; harmless if unavailable).
  upstream.on('open', () => {
    const sock =
      (
        upstream as unknown as {
          socket?: { setNoDelay?: (n: boolean) => void };
          _socket?: { setNoDelay?: (n: boolean) => void };
        }
      ).socket ??
      (
        upstream as unknown as {
          _socket?: { setNoDelay?: (n: boolean) => void };
        }
      )._socket;
    if (sock && typeof sock.setNoDelay === 'function') {
      try {
        sock.setNoDelay(true);
      } catch {
        /* best-effort */
      }
    }
  });

  const session = new RelaySession(deviceWs, upstream, device, config);

  // 3. Plumb device ↔ upstream message forwarding.
  deviceWs.on('message', (data, isBinary) =>
    session.onDeviceFrame(data as Buffer, isBinary)
  );
  // [idle-fix] esp_websocket_client sends a WS ping every 20s. Treat it as device activity so the 120s idle timeout doesn't fire while the user is connected but silent.
  deviceWs.on('ping', () => session.markDeviceActive());
  upstream.on('message', (data, isBinary) =>
    session.onUpstreamFrame(data as Buffer, isBinary)
  );

  deviceWs.on('close', (code, reason) =>
    session.shutdown('device-closed', { code, reason })
  );
  upstream.on('close', (code, reason) =>
    session.shutdown('upstream-closed', { code, reason })
  );
  deviceWs.on('error', err =>
    session.shutdown('device-error', { err: String(err) })
  );
  upstream.on('error', err =>
    session.shutdown('upstream-error', { err: String(err) })
  );

  try {
    await session.upstreamReady;
  } catch (e) {
    const code =
      e instanceof Error && /401/.test(e.message)
        ? 'unauthorized'
        : 'upstream_unavailable';
    sendErrorAndClose(
      deviceWs,
      makeError(
        code,
        e instanceof Error ? e.message : String(e),
        'upstream-open'
      )
    );
    return;
  }

  // 4. Tell the firmware we are alive — the device's WS handler expects a
  //    text frame `{"type":"session.ready",...}` to flip status to
  //    InternalStatus::kStreaming.
  sendJson(deviceWs, {
    type: 'session.ready',
    protocol: PROXY_SUBPROTOCOL,
    output_sample_rate_hz: DOWLINK_DEFAULT_SAMPLE_RATE_HZ,
  });

  log.info('relay session opened', {
    deviceId: device.deviceId,
    userId: device.userId,
    macAddress: device.macAddress,
  });
}

function sendErrorAndClose(ws: DeviceWs, payload: RelayErrorPayload) {
  try {
    sendJson(ws, { type: 'error', ...payload });
  } catch {
    /* drop */
  }
  try {
    ws.close(1011, payload.error_code);
  } catch {
    /* drop */
  }
}

function sendJson(ws: DeviceWs, obj: unknown) {
  ws.send(JSON.stringify(obj));
}

interface PendingToolCall {
  name: string;
  args: string;
  call_id: string;
}

/**
 * Per-connection relay. Holds bookkeeping for tool call stream assembly
 * (StepFun streams function_call_arguments across multiple deltas) and
 * downlink seq numbering.
 */
class RelaySession {
  // Mutable downlink seq counter (24-bit wraparound, ESP32 doesn't care).
  private downstreamSeq = 0;

  // Tool call stream assembly
  private pendingToolCall: PendingToolCall | null = null;

  // Lifecycle signals
  public upstreamReady: Promise<void>;
  private upstreamResolve!: () => void;
  private upstreamReject!: (e: Error) => void;

  // Idle timer (device-side)
  private deviceLastMsgMs = Date.now();
  private idleInterval: NodeJS.Timeout;
  private pingInterval: NodeJS.Timeout;
  private closed = false;
  // [session-update-fix] Buffer for text frames (like session.update) that
  // arrive from the device BEFORE the upstream WS is open. Without this, the
  // readyState guard in onDeviceFrame silently drops session.update, and
  // StepFun never learns the audio format / voice / instructions.
  private pendingTextFrames: Buffer[] = [];

  // [audio-pacing] Downlink audio pacing: buffer frames and drain at 1x
  // realtime speed so the ESP32's 256KB ringbuffer doesn't overflow when
  // StepFun generates TTS at 3-4x realtime.
  private downlinkQueue: {
    frame: Buffer;
    audioDurationMs: number;
    isLast: boolean;
  }[] = [];
  private downlinkTimer: NodeJS.Timeout | null = null;
  // [audio-pacing] Token-bucket pacer. downlinkTokens = audio-ms we may send
  // right now; refilled at 1x realtime (1ms audio per 1ms wall) and capped at
  // PACING_LOOK_AHEAD_MS. Since the device's playback ringbuffer has been
  // increased to 524288 bytes (~11s), we set the look-ahead to 1500ms (1.5s).
  // This allows the device to pre-buffer up to 1.5s of audio, ensuring smooth
  // playback even during long EPD UI refreshes (which take ~400-1200ms) and
  // network jitter, while still preventing buffer overflow.
  private static readonly PACING_LOOK_AHEAD_MS = 1500;
  private downlinkTokens = 0;
  private downlinkLastRefillMs = 0;
  // [diag] perf timestamp of the last upstream message, to measure onMessage
  // entry gap (StepFun send interval vs cloud event-loop block).
  private lastUpstreamPerfMs = 0;

  constructor(
    private readonly deviceWs: DeviceWs,
    private readonly upstream: NodeWebSocket,
    private readonly device: DeviceContext,
    private readonly config: RelayConfig
  ) {
    this.upstreamReady = new Promise<void>((res, rej) => {
      this.upstreamResolve = res;
      this.upstreamReject = rej;
    });
    this.upstream.once('open', () => {
      // Flush any text frames that were buffered while upstream was connecting.
      this.flushPendingTextFrames();
      this.upstreamResolve();
    });
    this.upstream.once('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      this.upstreamReject(new Error(`upstream handshake failed: HTTP ${code}`));
    });
    this.upstream.once('error', err => this.upstreamReject(err));

    this.idleInterval = setInterval(() => this.checkIdle(), 5_000);
    this.pingInterval = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
  }

  public shutdown(reason: string, fields?: Record<string, unknown>) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.idleInterval);
    clearInterval(this.pingInterval);
    // [audio-pacing] Stop the drain timer so queued frames don't fire after close.
    if (this.downlinkTimer) {
      clearTimeout(this.downlinkTimer);
      this.downlinkTimer = null;
    }
    this.downlinkQueue = [];
    log.info('relay session closed', {
      deviceId: this.device.deviceId,
      reason,
      ...fields,
    });
    try {
      this.upstream.close();
    } catch {
      /* drop */
    }
    try {
      this.deviceWs.close();
    } catch {
      /* drop */
    }
  }

  private checkIdle() {
    const silentFor = Date.now() - this.deviceLastMsgMs;
    if (silentFor > DEVICE_IDLE_TIMEOUT_MS) {
      log.warn('device idle timeout, closing', {
        deviceId: this.device.deviceId,
      });
      this.shutdown('device-idle');
    }
  }

  private heartbeat() {
    if (this.upstream.readyState === NodeWebSocket.OPEN) {
      try {
        this.upstream.ping();
      } catch {
        /* drop */
      }
    }
    if (this.deviceWs.readyState === 1 /* OPEN */) {
      try {
        this.deviceWs.ping();
      } catch {
        /* drop */
      }
    }
  }

  // -----------------------------------------------------------------
  // Device → Proxy → Upstream
  // -----------------------------------------------------------------

  public markDeviceActive() {
    this.deviceLastMsgMs = Date.now();
  }

  public onDeviceFrame(buf: Buffer, isBinary: boolean) {
    if (this.closed) return;
    this.deviceLastMsgMs = Date.now();

    // [crash-fix + session-update-fix] Guard against sending to upstream
    // while it's still CONNECTING. Binary frames (audio) are dropped - they
    // can't be usefully buffered. But TEXT frames (like session.update) are
    // buffered and flushed when upstream opens, so StepFun receives the
    // session configuration it needs to accept audio.
    if (this.upstream.readyState !== NodeWebSocket.OPEN) {
      if (!isBinary) {
        log.debug('buffering text frame: upstream not open', {
          readyState: this.upstream.readyState,
        });
        this.pendingTextFrames.push(buf);
      } else {
        log.debug('dropped binary frame: upstream not open', {
          readyState: this.upstream.readyState,
        });
      }
      return;
    }

    if (isBinary) {
      this.forwardUplinkAudio(buf);
      return;
    }
    // Text frames from the device are control events. We forward after
    // rewriting `session.update` so ESP32 can keep sending its model id
    // verbatim (it's currently the literal "wqn-flash-v2", which StepFun
    // would reject as an unknown model).
    let text = buf.toString('utf8');
    let deviceEventType = 'unknown';
    try {
      const evt = JSON.parse(text);
      if (evt && typeof evt.type === 'string') deviceEventType = evt.type;
      if (evt && evt.type === 'session.update') {
        text = this.rewriteSessionUpdate(evt);
        log.info('forwarding session.update to upstream', {
          session: evt.session,
        });
        sendJson(this.deviceWs, { type: 'state', stage: 'session.negotiated' });
      } else if (evt && evt.type === 'response.cancel') {
        // [barge-in-fix] Device barge-in: drop queued downlink audio so the stale
        // tail of the previous response doesn't keep filling the device ringbuffer
        // (root cause of post-barge-in ringbuf full / dropped frames).
        this.downlinkQueue = [];
        if (this.downlinkTimer) {
          clearTimeout(this.downlinkTimer);
          this.downlinkTimer = null;
        }
        this.downlinkTokens = 0;
        this.downlinkLastRefillMs = 0;
        log.info('barge-in: cleared downlink queue + timer');
      }
    } catch {
      /* not JSON, passthrough */
    }
    log.info('device -> upstream', { type: deviceEventType, len: text.length });
    this.upstream.send(text);
  }

  private forwardUplinkAudio(buf: Buffer) {
    const decoded = decodeWflvAudio(buf);
    if (!decoded) {
      log.debug('dropped malformed uplink frame', { len: buf.length });
      return;
    }
    // [empty-pcm-fix] The device sends a final frame with pcm_size=0 to
    // signal end-of-turn. Forwarding an empty append to StepFun triggers
    // "audio is required" error. Skip the append for empty PCM, but still
    // send commit if this is the last chunk.
    if (decoded.pcm.length === 0) {
      log.debug('uplink frame has empty PCM, skipping append', {
        flags: decoded.flags,
        isLast: isLastChunk(decoded.flags),
      });
      if (isLastChunk(decoded.flags)) {
        // [manual-mode] PTT manual mode (turn_detection=null): the device's
        // final empty frame signals end-of-turn. Mirror openai-realtime-api-beta
        // createResponse(): commit the audio buffer, then create the response.
        log.info('user finished speaking, committing + creating response');
        try {
          if (this.upstream.readyState === NodeWebSocket.OPEN) {
            this.upstream.send(
              JSON.stringify({ type: 'input_audio_buffer.commit' })
            );
            this.upstream.send(JSON.stringify({ type: 'response.create' }));
          }
        } catch (err) {
          log.warn('upstream commit/response send failed', {
            err: String(err),
          });
          this.shutdown('upstream-send-failed');
        }
      }
      return;
    }
    if (
      decoded.sampleRate !== UPLINK_SAMPLE_RATE_HZ ||
      decoded.channels !== 1
    ) {
      log.warn('uplink sample-rate/channels mismatch', {
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
      });
    }
    if (!isStreaming(decoded.flags)) {
      log.debug('uplink non-streaming chunk', { flags: decoded.flags });
    }

    // StepFun accepts JSON `input_audio_buffer.append` with base64 payload.
    // Frame size is fixed at CHUNK_BYTES; we forward whatever the device
    // sent and let the upstream chunk-size policy deal with it.
    // [24k-native] Device captures at 24kHz; StepFun expects 24kHz pcm16. No resample.
    const base64 = decoded.pcm.toString('base64');
    const evt = {
      type: 'input_audio_buffer.append',
      audio: base64,
    };
    // [commit-fix] Only send commit when the user has finished speaking
    // (isLastChunk = true, i.e. the device sent a final frame with
    // kFlagFinal). Sending commit on every 15ms audio chunk is a protocol
    // violation that causes StepFun to reject the session and disconnect.
    try {
      if (this.upstream.readyState !== NodeWebSocket.OPEN) return;
      this.upstream.send(JSON.stringify(evt));

      if (isLastChunk(decoded.flags)) {
        log.info('user finished speaking, committing audio buffer');
        const evt2 = { type: 'input_audio_buffer.commit' };
        if (this.upstream.readyState === NodeWebSocket.OPEN) {
          this.upstream.send(JSON.stringify(evt2));
        }
      }
    } catch (err) {
      log.warn('upstream send failed, shutting down relay', {
        err: String(err),
      });
      this.shutdown('upstream-send-failed');
    }
  }

  private flushPendingTextFrames() {
    if (this.pendingTextFrames.length === 0) return;
    log.info('flushing buffered text frames to upstream', {
      count: this.pendingTextFrames.length,
    });
    for (const buf of this.pendingTextFrames) {
      let text = buf.toString('utf8');
      try {
        const evt = JSON.parse(text);
        if (evt && evt.type === 'session.update') {
          text = this.rewriteSessionUpdate(evt);
          sendJson(this.deviceWs, {
            type: 'state',
            stage: 'session.negotiated',
          });
        }
      } catch {
        /* not JSON, passthrough */
      }
      try {
        this.upstream.send(text);
      } catch (err) {
        log.warn('failed to flush buffered text frame', { err: String(err) });
      }
    }
    this.pendingTextFrames = [];
  }

  private rewriteSessionUpdate(evt: any): string {
    // [api-fix] StepFun's session.update does NOT accept a "model" field -
    // model is a URL query param (?model=...), already appended in
    // handleConnection. Previous code injected session.model which is not
    // in the official spec and may cause StepFun to reject the update.
    // We also replace the device's empty/untrusted tool list with the
    // server-owned definitions when the internal executor is configured.
    const session = applyAiToolSessionConfig(
      { ...(evt.session ?? {}) },
      Boolean(this.config.executeToolUrl && this.config.proxySecret)
    );
    if (
      typeof session.voice === 'string' &&
      !ALLOWED_VOICES.has(session.voice)
    ) {
      session.voice = 'qingchunshaonv';
    }
    return JSON.stringify({ ...evt, session });
  }

  // -----------------------------------------------------------------
  // Upstream → Proxy → Device
  // -----------------------------------------------------------------

  public onUpstreamFrame(buf: Buffer, isBinary: boolean) {
    if (this.closed) return;
    // [diag] Measure onMessage entry gap with perf.now() (monotonic, sub-ms).
    // This is BEFORE JSON.parse / log / drain. If this gap is large while
    // event loop lag is low, StepFun is sending slowly. If both are large,
    // the cloud event loop is blocked.
    const nowPerf = performance.now();
    const upstreamGapMs =
      this.lastUpstreamPerfMs > 0 ? nowPerf - this.lastUpstreamPerfMs : 0;
    this.lastUpstreamPerfMs = nowPerf;
    // OpenAI/StepFun Realtime only uses text frames; if we see binary
    // upstream, the upstream has changed — log and ignore.
    if (isBinary) {
      log.warn('unexpected binary frame from upstream');
      return;
    }
    let evt: any;
    try {
      evt = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!evt || typeof evt.type !== 'string') return;

    // [diag] Log every event from StepFun so we can see exactly what
    // StepFun sends back (session.updated, error, response.audio.delta, etc.)
    log.info('upstream -> device', {
      type: evt.type,
      gapMs: Math.round(upstreamGapMs),
      hasDelta: typeof evt.delta === 'string',
      hasError: typeof evt.error === 'object',
      itemId: evt.item_id ?? evt.response_id ?? '',
    });

    switch (evt.type) {
      case 'response.audio.delta': {
        this.forwardDownlinkAudio(evt);
        return;
      }
      case 'response.audio.done': {
        // Mark the last chunk as 'final' so ESP32 can flush.
        sendJson(this.deviceWs, { type: 'state', stage: 'audio.complete' });
        // [pacing-fix] Reset the token bucket at response end so the next
        // response seeds fresh look-ahead on its first drain.
        this.downlinkTokens = 0;
        this.downlinkLastRefillMs = 0;
        // [tts-speed-fix] StepFun has finished generating the whole response;
        // the full audio is now in downlinkQueue. Start 1x drain so the device
        // receives a continuous 1x stream with no underrun gaps. (forwardDownlinkAudio
        // intentionally does NOT start the drain - see comment there.)
        if (!this.downlinkTimer && this.downlinkQueue.length > 0) {
          this.drainDownlinkQueue();
        }
        return;
      }
      case 'response.function_call_arguments.delta': {
        // Streamed args, accumulate for the call.
        if (!this.pendingToolCall) {
          this.pendingToolCall = {
            name: '',
            args: '',
            call_id: evt.call_id ?? '',
          };
        }
        if (typeof evt.call_id === 'string')
          this.pendingToolCall.call_id = evt.call_id;
        if (typeof evt.delta === 'string')
          this.pendingToolCall.args += evt.delta;
        return;
      }
      case 'response.function_call_arguments.done': {
        // Tool call ready to execute.
        const call_id = evt.call_id ?? this.pendingToolCall?.call_id ?? '';
        const name = evt.name ?? this.pendingToolCall?.name ?? '';
        const raw_args = evt.arguments ?? this.pendingToolCall?.args ?? '';
        this.pendingToolCall = null;
        void this.handleToolCall({ call_id, name, raw_args });
        return;
      }
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        sendJson(this.deviceWs, evt);
        return;
      }
      default: {
        // `session.created`, `conversation.item.*`, errors, etc — pass through
        sendJson(this.deviceWs, evt);
        return;
      }
    }
  }

  // [audio-pacing] Enqueue downlink audio for paced delivery instead of
  // sending immediately. StepFun generates TTS at 3-4x realtime; the ESP32
  // plays at 1x. Without pacing, the device's 256KB ringbuffer fills within
  // seconds of a long response.
  private forwardDownlinkAudio(evt: any) {
    const b64 = typeof evt.delta === 'string' ? evt.delta : null;
    if (!b64) return;
    const pcm24 = Buffer.from(b64, 'base64');
    if (pcm24.length === 0) return;
    // [24k-native] StepFun sends 24kHz; device plays 24kHz. No resample.
    this.downstreamSeq = (this.downstreamSeq + 1) >>> 0;
    const frame = encodeWflvAudio({
      pcm: pcm24,
      seq: this.downstreamSeq,
      streaming: !Boolean(evt.last),
      final: Boolean(evt.last),
    });
    // Audio duration of this chunk: pcm24 is 24kHz mono s16le
    const audioDurationMs =
      (pcm24.length / 2 / DOWLINK_DEFAULT_SAMPLE_RATE_HZ) * 1000;
    this.downlinkQueue.push({
      frame,
      audioDurationMs,
      isLast: Boolean(evt.last),
    });
    // [tts-speed-fix] Do NOT start draining here. StepFun generates TTS at
    // ~0.5x realtime with 100-1100ms inter-segment stalls (the official demo
    // has the SAME pattern - not a cloud/transport issue). Draining as frames
    // arrive means the device's 1x DAC consumes faster than StepFun produces
    // -> ringbuffer underrun -> 呲呲. Instead, buffer the whole response and
    // only start 1x drain on response.audio.done (see onUpstreamFrame). This
    // trades first-word latency (~TTS generation time, 3-8s) for zero underrun.
  }

  // [audio-pacing] Drain the downlink queue at ~1x realtime speed.
  // On each tick we calculate how much audio-time has elapsed since the
  // first frame was sent, then send enough frames to fill up to that point
  // plus a small look-ahead buffer (200ms) to prevent underrun.
  // [audio-pacing] Token-bucket drain: send frames while tokens permit, then
  // schedule the next tick for when the bucket refills enough for the next
  // frame. Refill is 1x realtime (1ms audio per 1ms wall) capped at
  // PACING_LOOK_AHEAD_MS, so an underrun gap (StepFun paused, queue empty)
  // cannot bank more than 200ms of burst capacity - the bug that overran the
  // ESP32 ringbuffer before.
  private drainDownlinkQueue() {
    if (this.closed || this.downlinkQueue.length === 0) {
      this.downlinkTimer = null;
      return;
    }
    const now = Date.now();
    if (this.downlinkLastRefillMs === 0) {
      // First drain of a response: seed look-ahead so the first frame isn't
      // delayed (DAC needs a running start to avoid initial underrun).
      this.downlinkTokens = RelaySession.PACING_LOOK_AHEAD_MS;
    } else {
      const dt = now - this.downlinkLastRefillMs;
      if (dt > 0) {
        this.downlinkTokens = Math.min(
          RelaySession.PACING_LOOK_AHEAD_MS,
          this.downlinkTokens + dt
        );
      }
    }
    this.downlinkLastRefillMs = now;
    // Send frames while the bucket can afford the next one.
    while (this.downlinkQueue.length > 0) {
      const entry = this.downlinkQueue[0];
      if (this.downlinkTokens < entry.audioDurationMs) break;
      this.downlinkQueue.shift();
      try {
        this.deviceWs.send(entry.frame, { binary: true });
      } catch {
        // Device disconnected; shutdown will be triggered by the close handler.
        break;
      }
      this.downlinkTokens -= entry.audioDurationMs;
      if (entry.isLast) {
        sendJson(this.deviceWs, { type: 'state', stage: 'audio.last' });
      }
    }
    if (this.downlinkQueue.length > 0) {
      // Wait until the bucket refills enough for the next frame.
      const next = this.downlinkQueue[0];
      const waitMs = Math.max(10, next.audioDurationMs - this.downlinkTokens);
      this.downlinkTimer = setTimeout(() => this.drainDownlinkQueue(), waitMs);
    } else {
      this.downlinkTimer = null;
    }
  }

  private async handleToolCall(call: ToolCallArgs) {
    if (!call.call_id || !call.name) {
      log.warn('dropped malformed tool call', { call });
      return;
    }
    // Notify device UI that a tool is in flight.
    sendJson(this.deviceWs, {
      type: 'tool.start',
      call_id: call.call_id,
      name: call.name,
    });

    const result = await executeToolOverHttp(
      this.config.executeToolUrl,
      this.config.proxySecret,
      this.device.userId,
      this.device.deviceId,
      call
    );

    // Forward result back upstream.
    injectToolResult(
      { sendText: msg => this.upstream.send(msg) },
      call,
      result
    );

    sendJson(this.deviceWs, {
      type: 'tool.done',
      call_id: call.call_id,
      name: call.name,
      ok: result.ok,
      display: result.display,
    });
  }
}

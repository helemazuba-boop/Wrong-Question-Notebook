/**
 * voiceRelay.ts — the per-connection state machine.
 *
 * One instance per ESP32 device WS upgrade. Lifecycle:
 *   1. open upstream WS to StepFun with our `Bearer ${STEP_API_KEY}`
 *   2. await a confirmed manual-PTT PCM configuration, then publish
 *      `session.ready` to the device
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
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { decodeWflvAudio, isLastChunk, isStreaming } from './frameIo.ts';
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
  fetchVoiceContext,
  injectToolResult,
  type ToolCallArgs,
} from './toolInterceptor.ts';
import { applyAiToolSessionConfig } from './sessionConfig.ts';
import type { VoiceContext } from '../../../lib/ai-tools/voice-context.ts';
import { FlashAudioDownlink } from './flashAudioDownlink.ts';

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
  bufferedAmount?: number;
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
  transcribeChatUrl: string;
  agentTranscribeUrl: string;
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

  // Configuration ACK, rather than socket-open, publishes session.ready.
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

interface ProviderResponse {
  generation: number;
  id?: string;
  cancelled: boolean;
  ended: boolean;
  continued: boolean;
  calls: Set<string>;
  textSource?: string;
}
interface PendingToolCall {
  name: string;
  args: string;
  call_id: string;
  response?: ProviderResponse;
  done: boolean;
  dispatched: boolean;
  completed: boolean;
}

/** Manual PTT relay. Socket openness, configuration ACK, response generation,
 * tool admission, provider completion and physical device playout are distinct. */
export class RelaySession {
  private readonly audio: FlashAudioDownlink;
  private readonly responses = new Map<string, ProviderResponse>();
  private readonly calls = new Map<string, PendingToolCall>();
  private readonly retiredResponseIds = new Set<string>();
  private providerResponse?: ProviderResponse;
  private queuedResponse?: {
    generation: number;
    event: Record<string, unknown>;
  };
  private configurationAck?: {
    instructions: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  private cancelTimer?: NodeJS.Timeout;
  private readonly initialTimer: NodeJS.Timeout;
  private configured = false;
  private initialConfigurationStarted = false;
  private epochEnabled = false;
  private sessionConfiguration: Promise<void> = Promise.resolve();
  private configurationSerial: Promise<void> = Promise.resolve();
  private voiceContext?: VoiceContext;
  private baseInstructions = '';
  private turnGeneration = 0;
  private pendingTextFrames: Buffer[] = [];
  private pendingTextBytes = 0;
  private uplinkSeq?: number;
  private uplinkSamples = 0;
  private readonly pendingCommits: number[] = [];
  private readonly inputItems = new Map<string, number>();
  private progressAt = 0;
  private deviceLastMsgMs = Date.now();
  private readonly idleInterval: NodeJS.Timeout;
  private readonly pingInterval: NodeJS.Timeout;
  private closed = false;
  public upstreamReady: Promise<void>;

  constructor(
    private readonly deviceWs: DeviceWs,
    private readonly upstream: NodeWebSocket,
    private readonly device: DeviceContext,
    private readonly config: RelayConfig
  ) {
    this.audio = new FlashAudioDownlink(deviceWs, reason =>
      this.fail('tts_failed', `播放中断：${reason}`, 'playback')
    );
    this.upstreamReady = new Promise<void>((resolve, reject) => {
      upstream.once('open', () => {
        this.flushPendingTextFrames();
        resolve();
      });
      upstream.once('unexpected-response', (_req, response) =>
        reject(
          new Error(
            `upstream handshake failed: HTTP ${response.statusCode ?? 0}`
          )
        )
      );
      upstream.once('error', reject);
    });
    // Constructor callers may use the session directly in tests/ports.
    // The connection handler still awaits and reports the same rejection.
    void this.upstreamReady.catch(() => {});
    this.initialTimer = setTimeout(
      () =>
        this.fail(
          'upstream_unavailable',
          'Flash 配置未确认，请重新连接',
          'configuration'
        ),
      30000
    );
    this.idleInterval = setInterval(() => this.checkIdle(), 1000);
    this.pingInterval = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
  }

  public shutdown(reason: string, fields?: Record<string, unknown>) {
    if (this.closed) return;
    this.closed = true;
    this.turnGeneration++;
    clearInterval(this.idleInterval);
    clearInterval(this.pingInterval);
    clearTimeout(this.initialTimer);
    clearTimeout(this.cancelTimer);
    const ack = this.configurationAck;
    this.configurationAck = undefined;
    if (ack) {
      clearTimeout(ack.timer);
      ack.reject(new Error('relay closed'));
    }
    this.audio.close();
    this.pendingTextFrames = [];
    this.pendingTextBytes = 0;
    this.queuedResponse = undefined;
    log.info('relay session closed', {
      deviceId: this.device.deviceId,
      reason,
      ...fields,
    });
    try {
      this.upstream.close();
    } catch {
      /* already closed */
    }
    try {
      this.deviceWs.close();
    } catch {
      /* already closed */
    }
  }

  private fail(
    code: RelayErrorPayload['error_code'],
    message: string,
    stage: string
  ) {
    if (this.closed) return;
    try {
      sendJson(this.deviceWs, {
        type: 'error',
        ...makeError(code, message, stage),
        error: { code, message },
        turn_id: this.turnGeneration,
      });
    } catch {
      /* releasing upstream does not depend on error delivery */
    } finally {
      this.shutdown(`${stage}:${code}`);
    }
  }

  private sendUpstream(event: unknown): boolean {
    if (this.closed) return false;
    const text = JSON.stringify(event);
    if (
      this.upstream.readyState !== NodeWebSocket.OPEN ||
      Buffer.byteLength(text) + (this.upstream.bufferedAmount ?? 0) > 256 * 1024
    ) {
      this.fail(
        'upstream_unavailable',
        '语音链路拥堵，结果可能尚未确认，请检查原记录',
        'uplink'
      );
      return false;
    }
    try {
      this.upstream.send(text);
      return true;
    } catch {
      this.fail(
        'upstream_unavailable',
        '语音链路中断，请检查本轮结果',
        'uplink'
      );
      return false;
    }
  }

  private sendDevice(event: Record<string, unknown>) {
    if (this.closed) return;
    const text = JSON.stringify(event);
    if (
      Buffer.byteLength(text) + (this.deviceWs.bufferedAmount ?? 0) >
      256 * 1024
    ) {
      this.fail('tts_failed', '设备接收拥堵，请检查本轮结果', 'downlink');
      return;
    }
    try {
      this.deviceWs.send(text);
    } catch {
      this.shutdown('device-send-failed');
    }
  }

  private checkIdle() {
    if (Date.now() - this.deviceLastMsgMs > DEVICE_IDLE_TIMEOUT_MS)
      this.shutdown('device-idle');
    if (
      (this.providerResponse || this.queuedResponse) &&
      this.progressAt &&
      Date.now() - this.progressAt > 45000
    )
      this.fail(
        'upstream_unavailable',
        '本轮结果暂无法确认，请先检查原记录',
        'response-timeout'
      );
  }

  private heartbeat() {
    for (const socket of [this.upstream, this.deviceWs]) {
      if (socket.readyState === 1)
        try {
          socket.ping();
        } catch {
          /* close handler owns cleanup */
        }
    }
  }

  public markDeviceActive() {
    this.deviceLastMsgMs = Date.now();
  }

  public onDeviceFrame(buf: Buffer, isBinary: boolean) {
    if (this.closed) return;
    this.markDeviceActive();
    if (buf.length > 64 * 1024)
      return this.fail('protocol_mismatch', '语音帧过大', 'uplink');
    if (this.upstream.readyState !== NodeWebSocket.OPEN) {
      if (
        isBinary ||
        this.pendingTextFrames.length >= 4 ||
        this.pendingTextBytes + buf.length > 64 * 1024
      )
        return this.fail('upstream_unavailable', '语音连接尚未就绪', 'uplink');
      this.pendingTextFrames.push(Buffer.from(buf));
      this.pendingTextBytes += buf.length;
      return;
    }
    if (isBinary) return this.forwardUplinkAudio(buf);
    let event: any;
    try {
      event = JSON.parse(buf.toString('utf8'));
    } catch {
      return this.fail('protocol_mismatch', '无效语音控制帧', 'control');
    }
    switch (event?.type) {
      case 'session.update':
        if (this.initialConfigurationStarted)
          return this.fail(
            'protocol_mismatch',
            '重复的初始配置',
            'configuration'
          );
        this.initialConfigurationStarted = true;
        this.epochEnabled = event.wqn?.playback_epoch === 1;
        this.audio.negotiateEpoch(this.epochEnabled);
        this.baseInstructions =
          typeof event.session?.instructions === 'string'
            ? event.session.instructions
            : '';
        this.sessionConfiguration = this.configureSession(event);
        return;
      case 'response.cancel':
        this.turnGeneration++;
        this.queuedResponse = undefined;
        this.retireResponses();
        this.cancelProviderResponse();
        return;
      case 'response.create':
        void this.beginTurn();
        return;
      default:
        return this.fail(
          'protocol_mismatch',
          '不支持的语音控制命令',
          'control'
        );
    }
  }

  private forwardUplinkAudio(buf: Buffer) {
    const decoded = decodeWflvAudio(buf);
    if (
      !this.configured ||
      !decoded ||
      decoded.sampleRate !== UPLINK_SAMPLE_RATE_HZ ||
      decoded.channels !== 1 ||
      !isStreaming(decoded.flags) ||
      (decoded.flags & ~3) !== 0 ||
      buf.readUInt32LE(20) !== 0 ||
      decoded.pcm.length % 2 !== 0 ||
      (decoded.pcm.length === 0 && !isLastChunk(decoded.flags)) ||
      (this.uplinkSeq !== undefined &&
        decoded.seq !== (this.uplinkSeq + 1) >>> 0)
    ) {
      this.fail(
        'protocol_mismatch',
        '录音帧格式或顺序错误，本轮未提交',
        'uplink'
      );
      return;
    }
    this.uplinkSeq = decoded.seq;
    if (decoded.pcm.length) {
      if (
        !this.sendUpstream({
          type: 'input_audio_buffer.append',
          audio: decoded.pcm.toString('base64'),
        })
      )
        return;
      this.uplinkSamples += decoded.pcm.length / 2;
    }
    if (isLastChunk(decoded.flags)) {
      if (this.uplinkSamples === 0)
        return this.fail('protocol_mismatch', '空录音未提交', 'uplink');
      this.uplinkSamples = 0;
      void this.beginTurn(true);
    }
  }

  private flushPendingTextFrames() {
    const frames = this.pendingTextFrames;
    this.pendingTextFrames = [];
    this.pendingTextBytes = 0;
    for (const frame of frames) this.onDeviceFrame(frame, false);
  }

  private async configureSession(event: any) {
    try {
      if (this.config.executeToolUrl && this.config.proxySecret)
        this.voiceContext = await fetchVoiceContext(
          this.config.executeToolUrl,
          this.config.proxySecret,
          this.device.userId,
          this.device.deviceId
        );
      if (this.closed) return;
      await this.updateConfiguration(event);
      if (this.closed) return;
      this.configured = true;
      clearTimeout(this.initialTimer);
      this.sendDevice({ type: 'state', stage: 'session.negotiated' });
      this.sendDevice({
        type: 'session.ready',
        protocol: PROXY_SUBPROTOCOL,
        output_sample_rate_hz: DOWLINK_DEFAULT_SAMPLE_RATE_HZ,
        wqn: {
          playback_epoch: this.epochEnabled ? 1 : 0,
          turn_detection: 'manual',
        },
      });
    } catch (error) {
      log.warn('voice configuration failed', { err: String(error) });
      this.closeForContextFailure();
    }
  }

  private updateConfiguration(event: any, generation?: number): Promise<void> {
    const next = this.configurationSerial.then(() => {
      if (generation !== undefined && generation !== this.turnGeneration)
        return;
      return this.sendConfigurationAndWait(event);
    });
    this.configurationSerial = next.catch(() => {});
    return next;
  }

  private sendConfigurationAndWait(event: any): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.configurationAck)
      return Promise.reject(new Error('overlapping session update'));
    const rewritten = this.rewriteSessionUpdate(event);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.configurationAck = undefined;
        reject(new Error('session.updated timeout'));
      }, 10000);
      this.configurationAck = {
        instructions: rewritten.session.instructions ?? '',
        resolve,
        reject,
        timer,
      };
      this.sendUpstream(rewritten);
    });
  }

  private closeForContextFailure() {
    this.fail(
      'internal',
      'Voice context or configuration unavailable',
      'context'
    );
  }

  private async beginTurn(commit = false) {
    const generation = ++this.turnGeneration;
    // Ordered after all old device-bound frames, before any new-turn event.
    // This is relay admission, not provider success or a durable write ACK.
    this.sendDevice({ type: 'turn.started', turn_id: generation });
    const anchorAt = new Date().toISOString();
    this.progressAt = Date.now();
    this.retireResponses();
    this.cancelProviderResponse();
    if (commit) {
      if (this.pendingCommits.length >= 16)
        return this.fail('protocol_mismatch', '录音提交未确认', 'commit');
      this.pendingCommits.push(generation);
      if (!this.sendUpstream({ type: 'input_audio_buffer.commit' })) return;
    }
    try {
      await this.sessionConfiguration;
      if (this.config.executeToolUrl && this.config.proxySecret) {
        const context = await fetchVoiceContext(
          this.config.executeToolUrl,
          this.config.proxySecret,
          this.device.userId,
          this.device.deviceId,
          anchorAt
        );
        if (this.closed || generation !== this.turnGeneration) return;
        this.voiceContext = context;
        await this.updateConfiguration(
          {
            type: 'session.update',
            session: { instructions: this.baseInstructions },
          },
          generation
        );
      }
      if (!this.closed && this.configured && generation === this.turnGeneration)
        this.requestResponse({ type: 'response.create' }, generation);
    } catch (error) {
      // Context denial is a connection-level auth failure even after cancellation.
      log.warn('voice turn configuration failed', { err: String(error) });
      this.closeForContextFailure();
    }
  }

  private rewriteSessionUpdate(event: any): {
    type: string;
    session: Record<string, any>;
  } {
    const session = applyAiToolSessionConfig(
      {
        ...(event.session ?? {}),
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: null,
      },
      Boolean(this.config.executeToolUrl && this.config.proxySecret),
      this.voiceContext
    );
    delete session.model;
    if (typeof session.voice === 'string' && !ALLOWED_VOICES.has(session.voice))
      session.voice = 'qingchunshaonv';
    // Transport capabilities stay at WQN; the provider sees its own contract.
    return { type: 'session.update', session };
  }

  private requestResponse(event: Record<string, unknown>, generation: number) {
    if (this.closed || generation !== this.turnGeneration) return;
    if (this.providerResponse) {
      this.queuedResponse = { event, generation };
      return;
    }
    this.providerResponse = {
      generation,
      cancelled: false,
      ended: false,
      continued: false,
      calls: new Set(),
    };
    this.progressAt = Date.now();
    this.sendUpstream(event);
  }

  private cancelProviderResponse() {
    const response = this.providerResponse;
    if (!response || response.cancelled) return;
    response.cancelled = true;
    this.sendUpstream({ type: 'response.cancel' });
    clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(
      () =>
        this.fail(
          'upstream_unavailable',
          '上一轮取消未确认，请重新连接并检查原记录',
          'cancel'
        ),
      10000
    );
  }

  private releaseProvider(response: ProviderResponse) {
    response.ended = true;
    if (this.providerResponse !== response) return;
    this.providerResponse = undefined;
    clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
    const queued = this.queuedResponse;
    this.queuedResponse = undefined;
    if (queued) this.requestResponse(queued.event, queued.generation);
  }

  private retireResponses() {
    for (const [id, response] of this.responses) {
      if (response.generation !== this.turnGeneration)
        this.retiredResponseIds.add(id);
    }
    for (const [id, call] of this.calls)
      if (!call.dispatched) this.calls.delete(id);
    while (this.retiredResponseIds.size > 256) {
      const id = this.retiredResponseIds.values().next().value;
      if (id === undefined) break;
      this.retiredResponseIds.delete(id);
      this.responses.delete(id);
    }
    this.audio.cancel();
  }

  public onUpstreamFrame(buf: Buffer, isBinary: boolean) {
    if (this.closed) return;
    if (isBinary || buf.length > 512 * 1024)
      return this.fail('protocol_mismatch', '无效的模型响应帧', 'provider');
    let event: any;
    try {
      event = JSON.parse(buf.toString('utf8'));
    } catch {
      return this.fail('protocol_mismatch', '模型响应无法解析', 'provider');
    }
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'session.created') return;
    if (event.type === 'session.updated') {
      const ack = this.configurationAck,
        session = event.session;
      if (!ack) return;
      // An idle hello/default VAD profile cannot acknowledge our manual profile.
      if (
        !session ||
        session.input_audio_format !== 'pcm16' ||
        session.output_audio_format !== 'pcm16' ||
        session.turn_detection !== null ||
        (typeof session.instructions === 'string' &&
          session.instructions !== ack.instructions)
      )
        return;
      this.configurationAck = undefined;
      clearTimeout(ack.timer);
      ack.resolve();
      return;
    }
    if (event.type === 'error') {
      const message = String(
        event.error?.message ?? event.message ?? '模型服务错误'
      );
      // A no-response cancel error does not prove a pending response.create
      // has ended. Preserve its fence and let the bounded timer resolve it.
      if (
        this.providerResponse?.cancelled &&
        /no ongoing response to cancel/i.test(message)
      )
        return;
      return this.fail('upstream_unavailable', message, 'provider');
    }
    if (event.type === 'input_audio_buffer.committed') {
      const generation = this.pendingCommits.shift();
      if (typeof event.item_id === 'string' && generation !== undefined) {
        if (this.inputItems.size >= 256)
          this.inputItems.delete(this.inputItems.keys().next().value!);
        this.inputItems.set(event.item_id, generation);
      }
      return;
    }
    if (event.type.startsWith('conversation.item.input_audio_transcription.')) {
      if (
        typeof event.item_id === 'string' &&
        this.inputItems.get(event.item_id) !== this.turnGeneration
      )
        return;
      this.progressAt = Date.now();
      this.sendDevice({ ...event, turn_id: this.turnGeneration });
      return;
    }
    const id = event.response_id ?? event.response?.id;
    let response = typeof id === 'string' ? this.responses.get(id) : undefined;
    if (event.type === 'response.created') {
      if (typeof id !== 'string' || id.length === 0 || id.length > 256)
        return this.fail('protocol_mismatch', '模型缺少响应标识', 'provider');
      if (this.responses.has(id)) return;
      response = this.providerResponse;
      if (!response || response.id)
        return this.fail(
          'protocol_mismatch',
          '收到未请求的模型响应',
          'provider'
        );
      response.id = id;
      this.responses.set(id, response);
      if (response.cancelled || response.generation !== this.turnGeneration) {
        this.retiredResponseIds.add(id);
        this.sendUpstream({ type: 'response.cancel' });
        return;
      }
      this.progressAt = Date.now();
      this.audio.begin(id);
      this.sendDevice({ ...event, turn_id: response.generation });
      return;
    }
    if (
      event.type === 'response.cancelled' &&
      !response &&
      this.providerResponse?.cancelled &&
      this.providerResponse.id
    )
      response = this.providerResponse;
    if (event.type === 'response.done' || event.type === 'response.cancelled') {
      if (!response || response.ended) return;
      const status =
        event.type === 'response.cancelled'
          ? 'cancelled'
          : event.response?.status;
      const current =
        !response.cancelled && response.generation === this.turnGeneration;
      // The terminal response's output is authoritative association for StepFun
      // args.done variants that omit response_id. Buffering alone never writes.
      if (
        current &&
        status === 'completed' &&
        Array.isArray(event.response?.output)
      ) {
        for (const item of event.response.output)
          if (item?.type === 'function_call')
            this.collectTool(
              {
                ...item,
                type: 'response.function_call_arguments.done',
                response_id: response.id,
              },
              response
            );
      }
      this.audio.finish(response.id);
      this.releaseProvider(response);
      if (!current) return;
      this.progressAt = Date.now();
      if (status !== 'completed') {
        response.cancelled = true;
        this.audio.cancel();
        this.sendDevice({
          type: 'turn.done',
          status: ['failed', 'incomplete', 'cancelled'].includes(status)
            ? status
            : 'incomplete',
          response_id: response.id,
          turn_id: response.generation,
          status_details: event.response?.status_details ?? null,
        });
      } else if (response.calls.size === 0) {
        this.sendDevice({ ...event, turn_id: response.generation });
      } else {
        this.sendDevice({
          type: 'state',
          stage: 'tool.waiting',
          turn_id: response.generation,
        });
        this.maybeContinue(response);
      }
      return;
    }
    if (!response && typeof event.call_id === 'string')
      response = this.calls.get(event.call_id)?.response;
    if (
      !response ||
      response.cancelled ||
      response.generation !== this.turnGeneration ||
      response.ended
    )
      return;
    this.progressAt = Date.now();
    switch (event.type) {
      case 'response.output_item.added':
      case 'response.output_item.done':
        if (event.item?.type === 'function_call')
          this.collectTool(
            {
              ...event.item,
              type:
                event.type === 'response.output_item.done'
                  ? 'response.function_call_arguments.done'
                  : event.type,
            },
            response
          );
        return;
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done':
        this.collectTool(event, response);
        return;
      case 'response.audio.delta':
        this.audio.append(response.id, event.delta);
        return;
      case 'response.audio.done':
        this.audio.finish(response.id);
        return;
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        response.textSource ??= event.type;
        if (response.textSource === event.type)
          this.sendDevice({
            type: 'text.delta',
            delta: event.delta,
            response_id: response.id,
            turn_id: response.generation,
          });
        return;
      }
      default:
        this.sendDevice({ ...event, turn_id: response.generation });
        return;
    }
  }

  private collectTool(event: any, response: ProviderResponse) {
    const id = event.call_id;
    if (typeof id !== 'string' || !id || id.length > 256)
      return this.fail('protocol_mismatch', '工具调用缺少标识', 'tool');
    let call = this.calls.get(id);
    if (call && call.response !== response) return; // no cross-response call ID reuse
    if (!call) {
      if (this.calls.size >= 128 || response.calls.size >= 16)
        return this.fail('protocol_mismatch', '工具调用数量超限', 'tool');
      call = {
        call_id: id,
        name: '',
        args: '',
        done: false,
        dispatched: false,
        completed: false,
        response,
      };
      this.calls.set(id, call);
      response.calls.add(id);
    }
    if (call.dispatched) return;
    if (typeof event.name === 'string') call.name = event.name;
    if (event.type === 'response.function_call_arguments.done') {
      if (typeof event.arguments === 'string') call.args = event.arguments;
      call.done = true;
    } else if (typeof event.delta === 'string') call.args += event.delta;
    if (Buffer.byteLength(call.args) > 64 * 1024 || call.name.length > 128)
      return this.fail('protocol_mismatch', '工具参数超限', 'tool');
    if (
      call.done &&
      call.name &&
      !response.cancelled &&
      response.generation === this.turnGeneration
    )
      void this.handleToolCall(call, response);
  }

  private async handleToolCall(
    call: PendingToolCall,
    response: ProviderResponse
  ) {
    if (
      this.closed ||
      response.cancelled ||
      response.generation !== this.turnGeneration ||
      call.dispatched
    )
      return;
    call.dispatched = true; // admission is synchronous, before HTTP starts
    const args: ToolCallArgs = {
      call_id: call.call_id,
      name: call.name,
      raw_args: call.args,
    };
    const anchor = this.voiceContext?.now;
    this.sendDevice({
      type: 'tool.start',
      call_id: call.call_id,
      name: call.name,
      args: call.args,
      response_id: response.id,
      turn_id: response.generation,
    });
    const result = await executeToolOverHttp(
      this.config.executeToolUrl,
      this.config.proxySecret,
      this.device.userId,
      this.device.deviceId,
      args,
      anchor
    );
    call.completed = true;
    if (this.closed) return; // executor/idempotency receipt survives connection close
    injectToolResult(
      {
        sendText: text => {
          this.sendUpstream(JSON.parse(text));
        },
      },
      args,
      result,
      false
    );
    const retired =
      response.cancelled || response.generation !== this.turnGeneration;
    this.sendDevice({
      type: retired ? 'tool.receipt' : result.ok ? 'tool.result' : 'tool.error',
      call_id: call.call_id,
      tool_call_id: call.call_id,
      name: call.name,
      ok: result.ok,
      display: result.display,
      error: result.error ?? null,
      response_id: response.id,
      turn_id: response.generation,
      retired,
    });
    if (!retired) this.progressAt = Date.now();
    this.maybeContinue(response);
  }

  private maybeContinue(response: ProviderResponse) {
    if (
      this.closed ||
      !response.ended ||
      response.cancelled ||
      response.continued ||
      response.generation !== this.turnGeneration ||
      response.calls.size === 0
    )
      return;
    for (const id of response.calls) if (!this.calls.get(id)?.completed) return;
    response.continued = true;
    this.requestResponse(
      { type: 'response.create', response: { modalities: ['text', 'audio'] } },
      response.generation
    );
  }
}

/**
 * batchVoiceRelay.ts — Relay for STD/PRO WebSocket Voice Transport (wqn-voice-v2).
 *
 * Implements:
 *   1. WFLV PCM streaming accumulation during utterance recording.
 *   2. Server-side validation (16kHz s16le mono, monotonically increasing sequence, byte limits).
 *   3. Upon FINAL frame: one-time Buffer concatenation and internal POST to Next.js transcribe-chat.
 *   4. Streaming SSE text chunks forwarding back to device via WebSocket text frames.
 *   5. State machine: IDLE -> RECEIVING -> HANDOFF -> PROCESSING -> IDLE.
 *      (Strict state checking, no implicit barge-in).
 */

import type { IncomingMessage } from 'node:http';
import { decodeVoiceV2Audio, isLastChunk } from './frameIo.ts';
import { log } from './logger.ts';
import {
  MAX_STD_PRO_PCM_BYTES,
  STD_PRO_SAMPLE_RATE_HZ,
  VOICE_SUBPROTOCOL,
  type DeviceContext,
} from './types.ts';
import type { RelayConfig, DeviceWs } from './voiceRelay.ts';

interface ActiveTurn {
  requestId: string;
  tier: 'std' | 'pro';
  conversationId: string | null;
  enableThinking?: boolean;
  reasoningEffort?: string;
  expectedSeq: number;
  pcmChunks: Buffer[];
  totalBytes: number;
  state: 'RECEIVING' | 'HANDOFF' | 'PROCESSING';
  abortController: AbortController;
}

function sendSseEvent(
  ws: DeviceWs,
  event: string,
  data: Record<string, unknown>
): void {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function sendSseError(
  ws: DeviceWs,
  code: string,
  message: string,
  stage?: string
): void {
  sendSseEvent(ws, 'error', {
    error_code: code,
    code,
    message,
    ...(stage ? { stage } : {}),
  });
}

export async function handleBatchVoiceConnection(
  deviceWs: DeviceWs,
  device: DeviceContext,
  req: IncomingMessage,
  config: RelayConfig
): Promise<void> {
  if (!config.realtimeEnabled) {
    sendSseError(deviceWs, 'disabled', 'Voice service disabled');
    deviceWs.close(1011, 'disabled');
    return;
  }

  if (!config.transcribeChatUrl) {
    log.error('transcribeChatUrl not configured in RelayConfig', {
      deviceId: device.deviceId,
    });
    sendSseError(
      deviceWs,
      'internal',
      'Transcribe-chat endpoint not configured'
    );
    deviceWs.close(1011, 'internal');
    return;
  }

  // Transiently read the original device bearer token for upstream authorization.
  // Never stored in DeviceContext and never logged.
  const rawAuth = req.headers['authorization'] ?? '';
  const deviceBearer = rawAuth.startsWith('Bearer ')
    ? rawAuth.slice(7).trim()
    : '';

  let currentTurn: ActiveTurn | null = null;
  let isClosed = false;

  function cleanupTurn(reason: string) {
    if (!currentTurn) return;
    try {
      currentTurn.abortController.abort();
    } catch {
      /* drop */
    }
    currentTurn.pcmChunks = [];
    currentTurn.totalBytes = 0;
    currentTurn = null;
    log.info('batch voice turn cleaned up', {
      deviceId: device.deviceId,
      reason,
    });
  }

  deviceWs.on(
    'message',
    async (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isClosed) return;
      const rawBuf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as any);

      // 1. Text frames (control messages)
      if (!isBinary) {
        try {
          const text = rawBuf.toString('utf8');
          const msg = JSON.parse(text);

          if (msg && msg.type === 'voice.turn.start') {
            // Strict state enforcement: reject new START if a turn is already active
            if (currentTurn !== null) {
              log.warn('rejected START while turn is already active', {
                deviceId: device.deviceId,
                existingRequestId: currentTurn.requestId,
                newRequestId: msg.request_id,
                state: currentTurn.state,
              });
              sendSseError(
                deviceWs,
                'state_error',
                'A turn is already active on this connection'
              );
              return;
            }

            const requestId = String(msg.request_id || '').trim();
            if (!requestId) {
              sendSseError(
                deviceWs,
                'invalid_request',
                'request_id is required'
              );
              return;
            }

            currentTurn = {
              requestId,
              tier: msg.tier === 'pro' ? 'pro' : 'std',
              conversationId:
                typeof msg.conversation_id === 'string' && msg.conversation_id
                  ? msg.conversation_id
                  : null,
              enableThinking:
                typeof msg.enable_thinking === 'boolean'
                  ? msg.enable_thinking
                  : undefined,
              reasoningEffort:
                typeof msg.reasoning_effort === 'string'
                  ? msg.reasoning_effort
                  : undefined,
              expectedSeq: 0,
              pcmChunks: [],
              totalBytes: 0,
              state: 'RECEIVING',
              abortController: new AbortController(),
            };

            log.info('batch voice turn start', {
              deviceId: device.deviceId,
              requestId: currentTurn.requestId,
              tier: currentTurn.tier,
            });
            return;
          }

          if (msg && msg.type === 'voice.turn.abort') {
            if (
              currentTurn !== null &&
              currentTurn.requestId === msg.request_id &&
              currentTurn.state === 'RECEIVING'
            ) {
              log.info('batch voice turn aborted by device', {
                deviceId: device.deviceId,
                requestId: currentTurn.requestId,
              });
              cleanupTurn('device_aborted');
            }
            return;
          }
        } catch {
          /* ignore malformed text */
        }
        return;
      }

      // 2. Binary frames (WFLV audio chunks)
      if (!currentTurn || currentTurn.state !== 'RECEIVING') {
        log.debug('dropped binary frame: no active turn in RECEIVING state', {
          deviceId: device.deviceId,
        });
        return;
      }

      const decoded = decodeVoiceV2Audio(rawBuf);
      if (!decoded) {
        log.warn('dropped malformed WFLV frame', {
          deviceId: device.deviceId,
          len: rawBuf.length,
        });
        sendSseError(deviceWs, 'invalid_frame', 'Malformed WFLV frame');
        cleanupTurn('malformed_frame');
        return;
      }

      if (
        decoded.sampleRate !== STD_PRO_SAMPLE_RATE_HZ ||
        decoded.channels !== 1
      ) {
        log.warn('invalid audio format', {
          deviceId: device.deviceId,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
        });
        sendSseError(
          deviceWs,
          'invalid_audio',
          `Expected 16kHz mono s16le PCM, got ${decoded.sampleRate}Hz/${decoded.channels}ch`
        );
        cleanupTurn('invalid_audio_format');
        return;
      }

      if (decoded.pcm.length % 2 !== 0) {
        log.warn('unaligned pcm bytes', {
          deviceId: device.deviceId,
          len: decoded.pcm.length,
        });
        sendSseError(
          deviceWs,
          'invalid_audio',
          'PCM bytes must be 2-byte aligned'
        );
        cleanupTurn('unaligned_pcm');
        return;
      }

      if (decoded.seq !== currentTurn.expectedSeq) {
        log.warn('sequence gap detected', {
          deviceId: device.deviceId,
          expected: currentTurn.expectedSeq,
          actual: decoded.seq,
        });
        sendSseError(
          deviceWs,
          'sequence_gap',
          `Sequence gap: expected ${currentTurn.expectedSeq}, got ${decoded.seq}`
        );
        cleanupTurn('sequence_gap');
        return;
      }
      currentTurn.expectedSeq++;

      if (decoded.pcm.length > 0) {
        if (
          currentTurn.totalBytes + decoded.pcm.length >
          MAX_STD_PRO_PCM_BYTES
        ) {
          log.warn('pcm size exceeds maximum allowed bytes', {
            deviceId: device.deviceId,
            totalBytes: currentTurn.totalBytes + decoded.pcm.length,
            maxBytes: MAX_STD_PRO_PCM_BYTES,
          });
          sendSseError(
            deviceWs,
            'too_large',
            `Audio exceeds maximum allowed duration`
          );
          cleanupTurn('oversized_pcm');
          return;
        }
        currentTurn.pcmChunks.push(decoded.pcm);
        currentTurn.totalBytes += decoded.pcm.length;
      }

      // 3. FINAL frame: dispatch to Next.js transcribe-chat
      if (isLastChunk(decoded.flags)) {
        currentTurn.state = 'HANDOFF';
        const turn = currentTurn;
        const totalBytes = turn.totalBytes;
        const durationMs = Math.round(
          (totalBytes / (STD_PRO_SAMPLE_RATE_HZ * 2)) * 1000
        );

        try {
          if (totalBytes < 32000 || durationMs < 1000) {
            log.warn('pcm duration too short', {
              deviceId: device.deviceId,
              totalBytes,
              durationMs,
            });
            sendSseError(
              deviceWs,
              'invalid_audio',
              'Audio duration too short (< 1000ms)',
              'validation'
            );
            return;
          }

          log.info('server_final_received', {
            deviceId: device.deviceId,
            requestId: turn.requestId,
            totalBytes,
            durationMs,
          });

          // One-time Buffer concatenation
          const fullPcm = Buffer.concat(turn.pcmChunks, totalBytes);
          turn.pcmChunks = []; // Release chunk buffers immediately
          turn.state = 'PROCESSING';

          const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
            Authorization: `Bearer ${deviceBearer}`,
            'X-WQN-Internal-Proxy-Authorization': `Bearer ${config.proxySecret}`,
            'x-wqn-audio-sample-rate': '16000',
            'x-wqn-audio-sample-format': 's16le',
            'x-wqn-audio-channels': '1',
            'x-wqn-audio-duration-ms': String(durationMs),
            'x-wqn-ai-tier': turn.tier,
            'x-wqn-protocol': 'v2-streaming',
            'x-wqn-request-id': turn.requestId,
          };
          if (turn.conversationId) {
            headers['x-wqn-conversation-id'] = turn.conversationId;
          }
          if (turn.enableThinking !== undefined) {
            headers['x-wqn-enable-thinking'] = String(turn.enableThinking);
          }
          if (turn.reasoningEffort) {
            headers['x-wqn-reasoning-effort'] = turn.reasoningEffort;
          }

          log.info('internal_pipeline_post_start', {
            deviceId: device.deviceId,
            requestId: turn.requestId,
            durationMs,
            url: config.transcribeChatUrl,
          });

          const response = await fetch(config.transcribeChatUrl, {
            method: 'POST',
            headers,
            body: fullPcm,
            signal: turn.abortController.signal,
          });

          if (!response.ok || !response.body) {
            let errCode = 'model_failed';
            let errMessage = 'Internal pipeline failed';
            try {
              const errJson = (await response.json()) as any;
              if (errJson?.error?.code) errCode = errJson.error.code;
              if (errJson?.error?.message) errMessage = errJson.error.message;
            } catch {
              const rawText = await response.text().catch(() => '');
              if (rawText) errMessage = rawText.slice(0, 200);
            }
            sendSseError(deviceWs, errCode, errMessage, 'internal_handoff');
            return;
          }

          // Stream decoder to handle multi-byte UTF-8 boundaries safely across chunks
          const decoder = new TextDecoder('utf-8');
          const reader = response.body.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              const tail = decoder.decode();
              if (tail && deviceWs.readyState === 1 /* OPEN */) {
                deviceWs.send(tail);
              }
              break;
            }
            if (value && value.length > 0) {
              const textChunk = decoder.decode(value, { stream: true });
              if (textChunk && deviceWs.readyState === 1 /* OPEN */) {
                deviceWs.send(textChunk);
              }
            }
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError') {
            log.error('internal transcribe-chat stream error', {
              deviceId: device.deviceId,
              requestId: turn.requestId,
              err: String(err),
            });
            sendSseError(
              deviceWs,
              'model_failed',
              err instanceof Error ? err.message : 'Internal pipeline error',
              'stream'
            );
          }
        } finally {
          if (currentTurn === turn) {
            const reqId = turn.requestId;
            cleanupTurn('turn_completed');
            sendSseEvent(deviceWs, 'turn.released', { request_id: reqId });
          }
        }
      }
    }
  );

  deviceWs.on('close', (code, reason) => {
    isClosed = true;
    cleanupTurn(`ws_closed_${code}_${reason}`);
  });

  deviceWs.on('error', err => {
    log.warn('device ws error in batchVoiceRelay', {
      deviceId: device.deviceId,
      err: String(err),
    });
    cleanupTurn('ws_error');
  });

  // Emit initial session readiness frame
  deviceWs.send(
    JSON.stringify({
      type: 'session.ready',
      protocol: VOICE_SUBPROTOCOL,
      sample_rate_hz: STD_PRO_SAMPLE_RATE_HZ,
    })
  );

  log.info('batch voice relay session opened', {
    deviceId: device.deviceId,
    userId: device.userId,
  });
}

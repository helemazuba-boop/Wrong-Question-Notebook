/**
 * index.ts — Bun server entry.
 *
 * Uses Node.js http + the `ws` library (NOT Bun.serve). The
 * Dockerfile.realtime runtime is node:24-alpine + `npx tsx`, so Bun APIs
 * are not available; Bun.serve crashes with "ReferenceError: Bun is not defined".
 *
 * Endpoints:
 *   GET  /health                       → liveness for ECS
 *   WS   /api/esp32/realtime           → the Flash relay
 *
 * Path matching is strict on purpose — accidentally serving other routes
 * on 0.0.0.0 would be bad, given this process does not authenticate the
 * caller beyond the device Bearer.
 */

import 'dotenv/config';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { log } from './logger.ts';
import { AuthFailure, authenticateDevice } from './auth.ts';
import {
  handleConnection,
  type RelayConfig,
  type DeviceWs,
} from './voiceRelay.ts';
import { handleBatchVoiceConnection } from './batchVoiceRelay.ts';
import { PROXY_SUBPROTOCOL, VOICE_SUBPROTOCOL } from './types.ts';

function readConfig(): RelayConfig {
  const realtimeEnabled =
    (process.env.WQN_AI_REALTIME_ENABLED ?? 'true').toLowerCase() !== 'false';
  const secret = process.env.WQN_REALTIME_PROXY_SECRET ?? '';
  const internalBase = (process.env.WQN_INTERNAL_API_BASE ?? '').replace(
    /\/$/,
    ''
  );
  const endpoint = internalBase
    ? `${internalBase}/api/esp32/ai/execute-tool`
    : '';
  const transcribeChatUrl = internalBase
    ? `${internalBase}/api/esp32/ai/transcribe-chat?protocol=v2-streaming`
    : '';
  if (!endpoint) {
    log.warn('WQN_INTERNAL_API_BASE not set — tool calls will be skipped', {});
  }
  return {
    bind: process.env.WQN_FLASH_PROXY_BIND ?? '0.0.0.0',
    port: parseInt(process.env.WQN_FLASH_PROXY_PORT ?? '8080', 10),
    upstream: {
      url:
        process.env.STEP_TTS_REALTIME_URL ??
        'wss://api.stepfun.com/v1/realtime',
      apiKey: process.env.STEP_API_KEY ?? '',
      model: process.env.STEP_TTS_MODEL ?? 'stepaudio-2.5-realtime',
    },
    executeToolUrl: endpoint,
    transcribeChatUrl,
    proxySecret: secret,
    realtimeEnabled,
  };
}

const config = readConfig();

if (!config.upstream.apiKey) {
  log.error('STEP_API_KEY missing — refusing to start', {});
  process.exit(1);
}
if (config.executeToolUrl && !config.proxySecret) {
  log.error('WQN_INTERNAL_API_BASE set without WQN_REALTIME_PROXY_SECRET', {});
  process.exit(1);
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols: Set<string> | string[]) => {
    const protoSet = protocols instanceof Set ? protocols : new Set(protocols);
    if (protoSet.has(PROXY_SUBPROTOCOL)) return PROXY_SUBPROTOCOL;
    if (protoSet.has(VOICE_SUBPROTOCOL)) return VOICE_SUBPROTOCOL;
    return false;
  },
});

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname !== '/api/esp32/realtime') {
    socket.destroy();
    return;
  }

  // Subprotocol negotiation
  const protoHeader = req.headers['sec-websocket-protocol'] ?? '';
  const requestedProtos = String(protoHeader)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let selectedSubprotocol: string | null = null;
  if (requestedProtos.includes(PROXY_SUBPROTOCOL)) {
    selectedSubprotocol = PROXY_SUBPROTOCOL;
  } else if (requestedProtos.includes(VOICE_SUBPROTOCOL)) {
    selectedSubprotocol = VOICE_SUBPROTOCOL;
  }

  if (!selectedSubprotocol) {
    socket.write(
      'HTTP/1.1 426 Upgrade Required\r\n' +
        `x-wqn-error: subprotocol required: ${PROXY_SUBPROTOCOL} or ${VOICE_SUBPROTOCOL}\r\n` +
        '\r\n'
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    authenticateDevice(req)
      .then(device => {
        (ws as any).device = device;
        if (selectedSubprotocol === PROXY_SUBPROTOCOL) {
          handleConnection(
            ws as unknown as DeviceWs,
            device,
            req,
            config
          ).catch(err => {
            log.error('flash relay threw', {
              err: String(err),
              deviceId: device.deviceId,
            });
            try {
              ws.close(1011, 'relay_error');
            } catch {
              /* drop */
            }
          });
        } else {
          handleBatchVoiceConnection(
            ws as unknown as DeviceWs,
            device,
            req,
            config
          ).catch(err => {
            log.error('batch voice relay threw', {
              err: String(err),
              deviceId: device.deviceId,
            });
            try {
              ws.close(1011, 'relay_error');
            } catch {
              /* drop */
            }
          });
        }
      })
      .catch(e => {
        const err =
          e instanceof AuthFailure
            ? e
            : new AuthFailure('unauthorized', String(e));
        try {
          ws.send(JSON.stringify({ type: 'error', ...err.toPayload() }));
        } catch {
          /* drop */
        }
        ws.close(1011, err.code);
      });
  });
});

httpServer.listen(config.port, config.bind, () => {
  log.info('wqn-realtime-proxy listening', {
    bind: config.bind,
    port: config.port,
    upstream: config.upstream.url,
  });
});

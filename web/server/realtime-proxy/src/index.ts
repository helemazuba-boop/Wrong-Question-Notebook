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
import { PROXY_SUBPROTOCOL } from './types.ts';

function readConfig(): RelayConfig {
  const realtimeEnabled =
    (process.env.WQN_AI_REALTIME_ENABLED ?? 'true').toLowerCase() !== 'false';
  const secret = process.env.WQN_REALTIME_PROXY_SECRET ?? '';
  const internalBase = process.env.WQN_INTERNAL_API_BASE ?? '';
  const endpoint = internalBase
    ? `${internalBase.replace(/\/$/, '')}/api/esp32/ai/execute-tool`
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
        'wss://api.stepfun.com/step_plan/v1/realtime',
      apiKey: process.env.STEP_API_KEY ?? '',
      model: process.env.STEP_TTS_MODEL ?? 'stepaudio-2.5-realtime',
    },
    executeToolUrl: endpoint,
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

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname !== '/api/esp32/realtime') {
    socket.destroy();
    return;
  }

  // Subprotocol gate.
  const proto = req.headers['sec-websocket-protocol'] ?? '';
  const protos = String(proto)
    .split(',')
    .map(s => s.trim());
  if (!protos.includes(PROXY_SUBPROTOCOL)) {
    socket.write(
      'HTTP/1.1 426 Upgrade Required\r\n' +
        `x-wqn-error: subprotocol required: ${PROXY_SUBPROTOCOL}\r\n` +
        '\r\n'
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    // Auth happens after upgrade so we can send our domain error payload
    // as a text frame before closing, instead of a raw close frame.
    authenticateDevice(req)
      .then(device => {
        // Stash on the socket so any later listeners (close) can log it.
        (ws as any).device = device;
        // Kick off the long-lived relay. handleConnection wires its own
        // message/close listeners on `ws`, which take precedence over
        // these defaults for that event.
        handleConnection(ws as unknown as DeviceWs, device, req, config).catch(
          err => {
            log.error('relay threw', {
              err: String(err),
              deviceId: device.deviceId,
            });
            try {
              ws.close(1011, 'relay_error');
            } catch {
              /* drop */
            }
          }
        );
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

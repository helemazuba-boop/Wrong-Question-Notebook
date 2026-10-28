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
import type { RelayConfig } from './voiceRelay.ts';
import { handleRealtimeUpgrade } from './upgrade.ts';
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
  const agentTranscribeUrl = internalBase
    ? `${internalBase}/api/esp32/agent/transcribe?protocol=v2-streaming`
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
    agentTranscribeUrl,
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
  void handleRealtimeUpgrade(wss, req, socket, head, config).catch(error => {
    log.error('upgrade handler failed', { err: String(error) });
    socket.destroy();
  });
});

httpServer.listen(config.port, config.bind, () => {
  log.info('wqn-realtime-proxy listening', {
    bind: config.bind,
    port: config.port,
    upstream: config.upstream.url,
  });
});

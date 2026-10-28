import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import { AuthFailure, authenticateDevice } from './auth.ts';
import {
  handleConnection,
  type DeviceWs,
  type RelayConfig,
} from './voiceRelay.ts';
import { handleBatchVoiceConnection } from './batchVoiceRelay.ts';
import { PROXY_SUBPROTOCOL, VOICE_SUBPROTOCOL } from './types.ts';
import { log } from './logger.ts';

export const UPGRADE_AUTH_TIMEOUT_MS = 10000;

/** Do not send HTTP 101 until device/account authentication finishes. Firmware
 * sends session.update immediately on CONNECTED; accepting first and awaiting
 * auth would discard that first frame before the relay listeners exist. */
export async function handleRealtimeUpgrade(
  server: Pick<WebSocketServer, 'handleUpgrade'>,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: RelayConfig
): Promise<void> {
  let path: string;
  try {
    path = new URL(request.url ?? '/', 'http://relay.local').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (path !== '/api/esp32/realtime') {
    socket.destroy();
    return;
  }
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map(p => p.trim());
  const protocol = protocols.includes(PROXY_SUBPROTOCOL)
    ? PROXY_SUBPROTOCOL
    : protocols.includes(VOICE_SUBPROTOCOL)
      ? VOICE_SUBPROTOCOL
      : null;
  if (!protocol) {
    socket.end(
      `HTTP/1.1 426 Upgrade Required\r\nx-wqn-error: subprotocol required\r\nConnection: close\r\n\r\n`,
      () => socket.destroy()
    );
    return;
  }

  if (socket.destroyed) return;
  socket.pause();
  const controller = new AbortController();
  const startedAt = Date.now();
  let disconnected = false;
  const onClose = () => {
    disconnected = true;
    controller.abort(new Error('upgrade peer closed'));
  };
  const onError = () => {
    onClose();
    socket.destroy();
  };
  socket.once('close', onClose);
  socket.once('error', onError);
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new AuthFailure('internal', 'Device authentication timed out')
      ),
    UPGRADE_AUTH_TIMEOUT_MS
  );
  try {
    const device = await Promise.race([
      authenticateDevice(request, controller.signal),
      aborted,
    ]);
    if (disconnected || controller.signal.aborted || socket.destroyed) return;
    log.info('device upgrade authenticated', {
      deviceId: device.deviceId,
      protocol,
      authMs: Date.now() - startedAt,
    });
    server.handleUpgrade(request, socket, head, ws => {
      // handleConnection installs listeners synchronously before its first
      // await. Keep the transport paused until that installation completes.
      const run =
        protocol === PROXY_SUBPROTOCOL
          ? handleConnection
          : handleBatchVoiceConnection;
      void run(ws as unknown as DeviceWs, device, request, config).catch(
        error => {
          log.error('voice relay threw', {
            protocol,
            deviceId: device.deviceId,
            err: String(error),
          });
          try {
            ws.close(1011, 'relay_error');
          } catch {
            /* already closed */
          }
        }
      );
      socket.resume();
    });
  } catch (error) {
    if (disconnected || socket.destroyed) return;
    const failure =
      error instanceof AuthFailure
        ? error
        : new AuthFailure('internal', 'Failed to authenticate device');
    const status =
      failure.code === 'unauthorized'
        ? '401 Unauthorized'
        : failure.code === 'disabled'
          ? '403 Forbidden'
          : failure.code === 'rate_limited'
            ? '429 Too Many Requests'
            : '503 Service Unavailable';
    const body = JSON.stringify({ type: 'error', ...failure.toPayload() });
    log.warn('device upgrade rejected', {
      code: failure.code,
      authMs: Date.now() - startedAt,
    });
    socket.end(
      `HTTP/1.1 ${status}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nx-wqn-error: ${failure.code}\r\nconnection: close\r\n\r\n${body}`,
      () => socket.destroy()
    );
  } finally {
    clearTimeout(timer);
    socket.removeListener('close', onClose);
    socket.removeListener('error', onError);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

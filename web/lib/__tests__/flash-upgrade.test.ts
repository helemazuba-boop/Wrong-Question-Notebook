import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { Duplex } from 'node:stream';
import {
  beforeEach,
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AuthFailure } from '@/server/realtime-proxy/src/auth';
import type { RelayConfig } from '@/server/realtime-proxy/src/voiceRelay';

const { authenticate, context, batch, upstreams } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  context: vi.fn(),
  batch: vi.fn(),
  upstreams: [] as any[],
}));
vi.mock('@/server/realtime-proxy/src/auth', async () => ({
  ...(await vi.importActual('@/server/realtime-proxy/src/auth')),
  authenticateDevice: authenticate,
}));
vi.mock('@/server/realtime-proxy/src/toolInterceptor', async () => ({
  ...(await vi.importActual('@/server/realtime-proxy/src/toolInterceptor')),
  fetchVoiceContext: context,
}));
vi.mock('@/server/realtime-proxy/src/batchVoiceRelay', () => ({
  handleBatchVoiceConnection: batch,
}));
let upgradeApi: typeof import('@/server/realtime-proxy/src/upgrade');
const mockedWsPaths: string[] = [];
let RealWebSocketServer: any;
const realServers: any[] = [];
const mockUpstream = async () => {
  const { EventEmitter } = await import('node:events');
  class Upstream extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent: string[] = [];
    constructor() {
      super();
      upstreams.push(this);
    }
    send(text: string) {
      this.sent.push(text);
    }
    ping() {}
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', 1000, Buffer.alloc(0));
    }
  }
  return { WebSocket: Upstream };
};
beforeAll(async () => {
  const entry = createRequire(
    resolvePath(process.cwd(), 'server/realtime-proxy/src/voiceRelay.ts')
  ).resolve('ws');
  RealWebSocketServer = createRequire(import.meta.url)(entry).WebSocketServer;
  mockedWsPaths.push(entry);
  const wrapper = resolvePath(dirname(entry), 'wrapper.mjs');
  if (existsSync(wrapper)) mockedWsPaths.push(wrapper);
  for (const path of mockedWsPaths) vi.doMock(path, mockUpstream);
  upgradeApi = await import('@/server/realtime-proxy/src/upgrade');
});
afterAll(() => {
  for (const path of mockedWsPaths) vi.doUnmock(path);
});

class Device extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  send(text: string | Buffer) {
    this.sent.push(text);
  }
  ping() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
  events() {
    return this.sent
      .filter((text): text is string => typeof text === 'string')
      .map(text => JSON.parse(text));
  }
}
class Transport extends EventEmitter {
  destroyed = false;
  paused = false;
  writes: string[] = [];
  firstFrame?: () => void;
  pause() {
    this.paused = true;
    return this;
  }
  resume() {
    this.paused = false;
    this.firstFrame?.();
    return this;
  }
  end(data: string, done?: () => void) {
    this.writes.push(data);
    done?.();
    return this;
  }
  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}
const principal = {
  userId: 'user-1',
  deviceId: 'device-1',
  macAddress: 'fixture-mac',
};
const config: RelayConfig = {
  bind: '',
  port: 0,
  upstream: {
    url: 'wss://provider.invalid/v1/realtime',
    apiKey: 'fixture-only',
    model: 'stepaudio-3',
  },
  executeToolUrl: 'https://wqn.test/api/esp32/ai/execute-tool',
  proxySecret: 'fixture-only',
  transcribeChatUrl: '',
  agentTranscribeUrl: '',
  realtimeEnabled: true,
};
const devices: Device[] = [];
function setup(protocol = 'wqn-flash-v2', path = '/api/esp32/realtime') {
  const device = new Device(),
    socket = new Transport();
  devices.push(device);
  const request = {
    url: path,
    headers: {
      'sec-websocket-protocol': protocol,
      authorization: 'Bearer fixture-only',
    },
  };
  const upgrade = vi.fn((_req, transport, _head, accept) => {
    expect(transport.paused).toBe(true);
    accept(device);
  });
  const start = () =>
    upgradeApi.handleRealtimeUpgrade(
      { handleUpgrade: upgrade } as any,
      request as any,
      socket as any,
      Buffer.alloc(0),
      config
    );
  return { device, socket, request, upgrade, start };
}
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T01:00:00Z'));
  authenticate.mockResolvedValue(principal);
  context.mockResolvedValue({
    now: '2026-10-29T01:00:00Z',
    timezone: 'Asia/Shanghai',
    notebooks: [],
    notebooks_available: true,
    notebooks_truncated: false,
  });
  batch.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const server of realServers.splice(0)) {
    for (const client of server.clients) client.terminate();
    server.close();
  }
  for (const device of devices.splice(0)) device.close();
  for (const upstream of upstreams.splice(0)) upstream.close();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('authentication before realtime upgrade', () => {
  it('retains the first masked frame through real ws upgrade and accepts the StepFun omitted-VAD ACK without binding a TCP port', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        type: 'session.update',
        wqn: { playback_epoch: 1 },
        session: { instructions: 'wire fixture' },
      })
    );
    const frame = Buffer.alloc(6 + payload.length);
    const mask = Buffer.from([1, 2, 3, 4]);
    expect(payload.length).toBeLessThan(126);
    frame[0] = 0x81;
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    for (let i = 0; i < payload.length; i++)
      frame[6 + i] = payload[i] ^ mask[i % 4];
    class Wire extends Duplex {
      accepted = false;
      _read() {}
      _write(chunk: Buffer, _encoding: string, done: () => void) {
        if (!this.accepted && chunk.toString().startsWith('HTTP/1.1 101')) {
          this.accepted = true;
          this.push(frame); // the peer responds before handleUpgrade's callback
        }
        done();
      }
    }
    const socket = new Wire();
    const server = new RealWebSocketServer({ noServer: true });
    realServers.push(server);
    const request = {
      method: 'GET',
      url: '/api/esp32/realtime',
      headers: {
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'),
        'sec-websocket-protocol': 'wqn-flash-v2',
      },
    };
    let resolve!: (value: typeof principal) => void;
    authenticate.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    const pending = upgradeApi.handleRealtimeUpgrade(
      server,
      request as any,
      socket,
      Buffer.alloc(0),
      {
        ...config,
        upstream: {
          ...config.upstream,
          url: 'wss://api.stepfun.com/v1/realtime',
        },
      }
    );
    expect(socket.accepted).toBe(false);
    expect(server.clients.size).toBe(0);
    resolve(principal);
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.accepted).toBe(true);
    expect(upstreams).toHaveLength(1);
    const peer = [...server.clients][0] as any;
    const send = vi.spyOn(peer, 'send');
    const upstream = upstreams[0];
    upstream.readyState = 1;
    upstream.emit('open');
    await settle();
    const update = upstream.sent
      .map((text: string) => JSON.parse(text))
      .find((event: any) => event.type === 'session.update');
    expect(update?.session.instructions).toContain('wire fixture');
    const providerSession = { ...update.session };
    delete providerSession.turn_detection;
    upstream.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'session.updated', session: providerSession })
      ),
      false
    );
    await settle();
    expect(
      send.mock.calls.some(
        ([text]) =>
          typeof text === 'string' && JSON.parse(text).type === 'session.ready'
      )
    ).toBe(true);
  });
  it('retains immediate firmware session.update across delayed auth and upstream connect, then requires the real profile ACK', async () => {
    const h = setup();
    let resolve!: (value: typeof principal) => void;
    authenticate.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    const pending = h.start();
    expect(h.upgrade).not.toHaveBeenCalled();
    expect(upstreams).toHaveLength(0);
    h.socket.firstFrame = () => {
      expect(h.device.listenerCount('message')).toBe(1);
      h.device.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'session.update',
            wqn: { playback_epoch: 1 },
            session: { instructions: 'base' },
          })
        ),
        false
      );
    };
    await vi.advanceTimersByTimeAsync(400);
    expect(h.upgrade).not.toHaveBeenCalled();
    resolve(principal);
    await pending;
    expect(h.upgrade).toHaveBeenCalledTimes(1);
    expect(upstreams).toHaveLength(1);
    const upstream = upstreams[0];
    expect(upstream.sent).toEqual([]);
    upstream.readyState = 1;
    upstream.emit('open');
    await settle();
    const update = upstream.sent
      .map((text: string) => JSON.parse(text))
      .find((event: any) => event.type === 'session.update');
    expect(update.session.turn_detection).toBeNull();
    expect(update.session.input_audio_format).toBe('pcm16');
    expect(
      h.device.events().some(event => event.type === 'session.ready')
    ).toBe(false);
    upstream.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'session.updated', session: update.session })
      ),
      false
    );
    await settle();
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({ type: 'session.ready' })
    );
    await vi.advanceTimersByTimeAsync(30001);
    expect(h.device.readyState).toBe(1);
    expect(
      h.device
        .events()
        .some(event => event.message?.includes('Flash 配置未确认'))
    ).toBe(false);
  });
  it.each([
    ['unauthorized', '401 Unauthorized'],
    ['disabled', '403 Forbidden'],
  ] as const)('rejects %s before HTTP 101', async (code, status) => {
    const h = setup();
    authenticate.mockRejectedValue(new AuthFailure(code, 'rejected fixture'));
    await h.start();
    expect(h.upgrade).not.toHaveBeenCalled();
    expect(upstreams).toHaveLength(0);
    expect(h.socket.writes.join('')).toContain(status);
    expect(h.socket.destroyed).toBe(true);
  });
  it('bounds auth waiting and aborts the Supabase signal before rejecting the transport', async () => {
    const h = setup();
    authenticate.mockReturnValue(new Promise(() => {}));
    const pending = h.start();
    const signal = authenticate.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(upgradeApi.UPGRADE_AUTH_TIMEOUT_MS + 1);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(h.upgrade).not.toHaveBeenCalled();
    expect(h.socket.writes.join('')).toContain('503 Service Unavailable');
    expect(h.socket.destroyed).toBe(true);
  });
  it('does not open a paid upstream after a disconnected peer authenticates late', async () => {
    const h = setup();
    let resolve!: (value: typeof principal) => void;
    authenticate.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    const pending = h.start();
    h.socket.destroy();
    await pending;
    resolve(principal);
    await settle();
    expect(h.upgrade).not.toHaveBeenCalled();
    expect(upstreams).toHaveLength(0);
  });
  it('handles transport failure while auth is pending', async () => {
    const h = setup();
    authenticate.mockReturnValue(new Promise(() => {}));
    const pending = h.start();
    h.socket.emit('error', new Error('transport lost'));
    await pending;
    expect(h.socket.destroyed).toBe(true);
    expect(h.upgrade).not.toHaveBeenCalled();
  });
  it('keeps route/protocol rejection ahead of authentication', async () => {
    const h = setup('unsupported');
    await h.start();
    expect(authenticate).not.toHaveBeenCalled();
    expect(h.socket.writes.join('')).toContain('426 Upgrade Required');
    const other = setup('wqn-flash-v2', '/wrong');
    await other.start();
    expect(authenticate).not.toHaveBeenCalled();
    expect(other.socket.destroyed).toBe(true);
  });
  it('retains the STD/Agent batch route after authenticated upgrade', async () => {
    const h = setup('wqn-voice-v2');
    await h.start();
    expect(batch).toHaveBeenCalledWith(h.device, principal, h.request, config);
    expect(upstreams).toHaveLength(0);
  });
});

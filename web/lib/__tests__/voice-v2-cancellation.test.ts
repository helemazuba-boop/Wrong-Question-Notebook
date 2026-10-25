import { NextRequest } from 'next/server';
import {
  handleV2Streaming,
  loadV2RuntimeConfig,
} from '@/app/api/esp32/ai/transcribe-chat/v2-handler';

const { context, build, client, execute } = vi.hoisted(() => ({
  context: vi.fn(),
  build: vi.fn(),
  client: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('@/lib/ai-tools/voice-context-server', () => ({
  loadVoiceContext: context,
}));
vi.mock('@/app/api/esp32/ai/transcribe-chat/v2-tools', () => ({
  buildAiToolExecutor: build,
}));
vi.mock('@/lib/supabase-utils', () => ({ createServiceClient: client }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  build.mockReturnValue(execute);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

function request(signal?: AbortSignal) {
  return new NextRequest(
    'http://fixture.invalid/api/esp32/ai/transcribe-chat',
    {
      method: 'POST',
      body: Buffer.alloc(32000),
      signal,
    }
  );
}

const requestContext = {
  audio: new ArrayBuffer(32000),
  authResult: { deviceId: 'fixture', userId: 'fixture', macAddress: 'fixture' },
};

it.each(['request', 'consumer'] as const)(
  '%s cancellation stops waiting for context before ASR starts',
  async source => {
    const entered = deferred<void>();
    const loaded = deferred<unknown>();
    context.mockImplementation(() => {
      entered.resolve();
      return loaded.promise;
    });
    const parent = new AbortController();
    const response = await handleV2Streaming(
      request(parent.signal),
      loadV2RuntimeConfig(),
      requestContext
    );
    await entered.promise;
    const signal = client.mock.calls[0][0].signal as AbortSignal;
    if (source === 'request') {
      parent.abort();
      expect(await response.text()).toBe('');
    } else await response.body!.cancel();
    expect(signal.aborted).toBe(true);
    loaded.resolve({ notebooks: [], now: '2026-10-24', timezone: 'UTC' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(build).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }
);

it('context loading consumes the same turn budget and emits a terminal timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  context.mockImplementation(() => new Promise(() => {}));
  const response = await handleV2Streaming(
    request(),
    { ...loadV2RuntimeConfig(), turnTimeoutMs: 30 },
    requestContext
  );
  const body = response.text();
  await vi.advanceTimersByTimeAsync(30);
  expect(await body).toContain('asr_timeout');
  expect(build).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('derives the default turn budget from existing stages and accepts an explicit override', () => {
  vi.stubEnv('WQN_ESP32_AI_ASR_TIMEOUT_MS', '20');
  vi.stubEnv('WQN_ESP32_AI_LLM_TIMEOUT_MS', '50');
  vi.stubEnv('WQN_ESP32_AI_TURN_TIMEOUT_MS', '');
  expect(loadV2RuntimeConfig().turnTimeoutMs).toBe(70);
  vi.stubEnv('WQN_ESP32_AI_TURN_TIMEOUT_MS', '40');
  expect(loadV2RuntimeConfig().turnTimeoutMs).toBe(40);
});

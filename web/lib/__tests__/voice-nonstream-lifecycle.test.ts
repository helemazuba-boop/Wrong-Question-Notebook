import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST as agent } from '@/app/api/esp32/agent/transcribe/route';
import { POST as std } from '@/app/api/esp32/ai/transcribe-chat/route';
import {
  runEsp32AiProvider,
  runEsp32VoiceTranscription,
} from '@/lib/esp32-ai-provider';
import { fetchJsonWithTimeout } from '@/lib/sse-pipeline-asr';
import { runPipelineChat } from '@/lib/sse-pipeline-chat';
import { PipelinePusher } from '@/lib/sse-pipeline-types';
import { SseEventIdGenerator } from '@/lib/ai-stream';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
  stage: vi.fn(),
  cleanup: vi.fn(),
  context: vi.fn(),
  execute: vi.fn(),
  append: vi.fn(),
}));
vi.mock('@/lib/esp32-device-auth', () => ({ authenticateEsp32Device: m.auth }));
vi.mock('@/lib/esp32-ai-audio-staging', async original => ({
  ...(await original<typeof import('@/lib/esp32-ai-audio-staging')>()),
  stageEsp32AiAudioFile: m.stage,
}));
vi.mock('@/lib/supabase-utils', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/ai-tools/voice-context-server', () => ({
  loadVoiceContext: m.context,
}));
vi.mock('@/app/api/esp32/ai/transcribe-chat/v2-tools', () => ({
  buildAiToolExecutor: () => m.execute,
}));
vi.mock('@/lib/esp32-ai-conversation-store', () => ({
  appendTurns: m.append,
  loadTurns: async () => [],
  mintConversationId: () => 'synthetic-conversation',
  contextTurnsForLlm: () => [],
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const audio = new Int16Array(48000).fill(5000).buffer;
const input = {
  audio,
  sampleRate: 16000,
  channels: 1,
  sampleFormat: 's16le' as const,
  userId: 'user-a',
  deviceId: 'device-a',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  const result: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  void promise.then(
    value => {
      result.settled = true;
      result.value = value;
    },
    error => {
      result.settled = true;
      result.error = error;
    }
  );
  return result;
}
function asr() {
  return new Response(
    'data: {"type":"transcript.text.done","text":"synthetic"}\n\n'
  );
}
function reply() {
  return Response.json({
    choices: [{ message: { content: 'synthetic reply' } }],
  });
}
function toolReply() {
  return Response.json({
    choices: [
      {
        message: {
          tool_calls: ['call-a', 'call-b'].map(id => ({
            id,
            type: 'function',
            function: { name: 'create_notebook_note', arguments: '{}' },
          })),
        },
      },
    ],
  });
}
function request(kind: string, signal?: AbortSignal) {
  return new NextRequest(
    'http://fixture.invalid/api/esp32/' +
      (kind === 'std' ? 'ai/transcribe-chat' : 'agent/transcribe'),
    {
      method: 'POST',
      body: audio,
      signal,
      headers: {
        authorization: 'Bearer ' + 'a'.repeat(64),
        'content-type': 'application/octet-stream',
        'x-wqn-audio-sample-rate': '16000',
        'x-wqn-audio-sample-format': 's16le',
        'x-wqn-audio-channels': '1',
        'x-wqn-audio-duration-ms': '3000',
      },
    }
  );
}
function fakeTime() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}
beforeEach(() => {
  vi.resetAllMocks();
  _resetRateLimitStore();
  vi.stubGlobal('fetch', m.fetch);
  const environment: Record<string, string> = {
    WQN_ESP32_AI_ASR_PROVIDER: 'stepfun',
    WQN_ESP32_AI_ASR_FALLBACK_PROVIDER: 'none',
    WQN_ESP32_AI_ASR_TIMEOUT_MS: '50',
    WQN_ESP32_AI_LLM_TIMEOUT_MS: '50',
    WQN_ESP32_AI_TRANSCRIBE_CHAT_MOCK: '',
    WQN_ESP32_AGENT_TRANSCRIBE_MOCK: '',
    STEPFUN_API_KEY: 'fixture',
    STEPFUN_ASR_URL: 'https://fixture.invalid/asr',
    DASHSCOPE_API_KEY: 'fixture',
    DASHSCOPE_CHAT_API_KEY_STD: 'fixture',
    DASHSCOPE_CHAT_API_KEY_PRO: 'fixture',
    DASHSCOPE_ASR_MODEL: 'paraformer-v2',
    DASHSCOPE_ASR_POLL_INTERVAL_MS: '30',
    DASHSCOPE_ASR_POLL_ATTEMPTS: '10',
    SITE_URL: 'https://fixture.invalid',
  };
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  m.auth.mockResolvedValue({
    userId: 'user-a',
    deviceId: 'device-a',
    macAddress: 'AA:BB:CC:DD:EE:FF',
  });
  m.stage.mockResolvedValue({
    url: 'https://fixture.invalid/audio.wav',
    cleanup: m.cleanup,
  });
  m.context.mockResolvedValue(undefined);
  m.execute.mockResolvedValue({
    ok: true,
    display: 'saved',
    data: {
      action: {
        type: 'notebook_note_created',
        note_id: 'synthetic',
        title: 'synthetic',
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

for (const [kind, post] of [
  ['std', std],
  ['agent', agent],
] as const) {
  for (const provider of ['stepfun', 'dashscope']) {
    it.each([401, 403])(
      `${kind}/${provider}: upstream %i is not device authentication`,
      async status => {
        vi.stubEnv('WQN_ESP32_AI_ASR_PROVIDER', provider);
        m.fetch.mockResolvedValueOnce(
          Response.json(
            { error: { message: 'synthetic upstream rejection' } },
            { status }
          )
        );
        const response = await post(request(kind));
        expect(response.status).toBe(502);
        expect((await response.json()).error.code).toBe('asr_failed');
        expect(m.fetch).toHaveBeenCalledTimes(1);
      }
    );
    it(`${kind}/${provider}: upstream 429 stays rate limited`, async () => {
      vi.stubEnv('WQN_ESP32_AI_ASR_PROVIDER', provider);
      m.fetch.mockResolvedValueOnce(new Response('', { status: 429 }));
      const response = await post(request(kind));
      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe('rate_limited');
    });
  }
  it.each([401, 403])(
    `${kind}: genuine device admission %i is preserved`,
    async status => {
      m.auth.mockResolvedValueOnce(
        NextResponse.json(
          { success: false, error: { code: 'admission' } },
          { status }
        )
      );
      expect((await post(request(kind))).status).toBe(status);
      expect(m.fetch).not.toHaveBeenCalled();
      expect(m.stage).not.toHaveBeenCalled();
    }
  );
  it(`${kind}: ordinary success is preserved`, async () => {
    m.fetch.mockResolvedValueOnce(asr()).mockResolvedValueOnce(reply());
    const response = await post(request(kind));
    expect(response.status).toBe(200);
    expect((await response.json()).data.transcript).toBe('synthetic');
  });
  it(`${kind}: request cancellation reaches the actual ASR reader`, async () => {
    fakeTime();
    const cancel = vi.fn();
    const parent = new AbortController();
    m.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const result = observe(post(request(kind, parent.signal)));
    await vi.advanceTimersByTimeAsync(0);
    parent.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.settled).toBe(true);
    expect(result.value?.status).toBe(499);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(m.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(m.execute).not.toHaveBeenCalled();
  });
}

it.each(['asr', 'chat'] as const)(
  'streaming JSON %s helper separates upstream credentials',
  async stage => {
    m.fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(
      fetchJsonWithTimeout('https://fixture.invalid', {}, 1000, stage)
    ).rejects.toMatchObject({ status: 502 });
  }
);
it('streaming chat separates upstream credentials', async () => {
  m.fetch.mockResolvedValueOnce(new Response('', { status: 403 }));
  const pusher = new PipelinePusher(
    { emit: vi.fn() } as unknown as ConstructorParameters<
      typeof PipelinePusher
    >[0],
    new SseEventIdGenerator(),
    Date.now()
  );
  await expect(
    runPipelineChat(
      {
        apiKey: 'fixture',
        baseUrl: 'https://fixture.invalid',
        model: 'fixture',
        systemPrompt: 'fixture',
        llmTimeoutMs: 1000,
      },
      { transcript: 'synthetic' },
      pusher
    )
  ).rejects.toMatchObject({ status: 502 });
});

it('an already cancelled ordinary ASR request performs no work', async () => {
  const parent = new AbortController();
  parent.abort();
  m.fetch.mockResolvedValueOnce(asr());
  await expect(
    runEsp32VoiceTranscription({ ...input, ...{ signal: parent.signal } })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(m.fetch).not.toHaveBeenCalled();
});
it('cancellation during primary failure cannot start a fallback provider', async () => {
  fakeTime();
  const parent = new AbortController();
  vi.stubEnv('WQN_ESP32_AI_ASR_FALLBACK_PROVIDER', 'dashscope');
  m.fetch
    .mockImplementationOnce(async () => {
      parent.abort();
      throw new Error('synthetic network failure');
    })
    .mockResolvedValue(
      Response.json({
        output: {
          task_id: 'task',
          task_status: 'SUCCEEDED',
          text: 'synthetic',
        },
      })
    );
  const result = observe(
    runEsp32VoiceTranscription({ ...input, ...{ signal: parent.signal } })
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ name: 'AbortError' });
  expect(m.stage).not.toHaveBeenCalled();
  expect(m.fetch).toHaveBeenCalledTimes(1);
});
it('primary and fallback share one ASR deadline', async () => {
  fakeTime();
  vi.stubEnv('WQN_ESP32_AI_ASR_FALLBACK_PROVIDER', 'dashscope');
  m.fetch
    .mockImplementationOnce(
      () =>
        new Promise(resolve =>
          setTimeout(() => resolve(new Response('', { status: 503 })), 35)
        )
    )
    .mockImplementationOnce(() => new Promise(() => {}));
  const result = observe(runEsp32VoiceTranscription(input));
  await vi.advanceTimersByTimeAsync(50);
  expect(result.error).toMatchObject({ code: 'asr_timeout', status: 504 });
  expect(m.fetch).toHaveBeenCalledTimes(2);
  expect(m.fetch.mock.calls[1][1].signal.aborted).toBe(true);
  expect(m.cleanup).toHaveBeenCalledTimes(1);
});
it('polling waits share the ASR deadline and cannot start late requests', async () => {
  fakeTime();
  vi.stubEnv('WQN_ESP32_AI_ASR_PROVIDER', 'dashscope');
  m.fetch
    .mockResolvedValueOnce(Response.json({ output: { task_id: 'task' } }))
    .mockImplementation(async () =>
      Response.json({ output: { task_status: 'RUNNING' } })
    );
  const result = observe(runEsp32VoiceTranscription(input));
  await vi.advanceTimersByTimeAsync(50);
  expect(result.error).toMatchObject({ code: 'asr_timeout' });
  expect(m.fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(100);
  expect(m.fetch).toHaveBeenCalledTimes(3);
  expect(m.cleanup).toHaveBeenCalledTimes(1);
});
it('cancellation while staging stops admission and cleans up a late staging result', async () => {
  fakeTime();
  vi.stubEnv('WQN_ESP32_AI_ASR_PROVIDER', 'dashscope');
  const stage = deferred<{ url: string; cleanup: typeof m.cleanup }>();
  const parent = new AbortController();
  m.stage.mockReturnValueOnce(stage.promise);
  const result = observe(
    runEsp32VoiceTranscription({ ...input, ...{ signal: parent.signal } })
  );
  await vi.advanceTimersByTimeAsync(0);
  parent.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ name: 'AbortError' });
  stage.resolve({
    url: 'https://fixture.invalid/audio.wav',
    cleanup: m.cleanup,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(m.cleanup).toHaveBeenCalledTimes(1);
  expect(m.fetch).not.toHaveBeenCalled();
});
it('cancellation stops a pending transcript download and cleans staged audio', async () => {
  fakeTime();
  vi.stubEnv('WQN_ESP32_AI_ASR_PROVIDER', 'dashscope');
  const parent = new AbortController();
  m.fetch
    .mockResolvedValueOnce(Response.json({ output: { task_id: 'task' } }))
    .mockResolvedValueOnce(
      Response.json({
        output: {
          task_status: 'SUCCEEDED',
          transcription_url: 'https://fixture.invalid/result',
        },
      })
    )
    .mockImplementationOnce(() => new Promise(() => {}));
  const result = observe(
    runEsp32VoiceTranscription({ ...input, ...{ signal: parent.signal } })
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(m.fetch).toHaveBeenCalledTimes(3);
  parent.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ name: 'AbortError' });
  expect(m.fetch.mock.calls[2][1].signal.aborted).toBe(true);
  expect(m.cleanup).toHaveBeenCalledTimes(1);
});
it('cancellation while loading chat context prevents another provider request', async () => {
  fakeTime();
  const parent = new AbortController();
  m.fetch.mockResolvedValueOnce(asr());
  m.context.mockReturnValueOnce(new Promise(() => {}));
  const result = observe(
    runEsp32AiProvider({ ...input, ...{ signal: parent.signal } })
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(m.context).toHaveBeenCalledTimes(1);
  parent.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ name: 'AbortError' });
  expect(m.fetch).toHaveBeenCalledTimes(1);
});
it('cancellation stops an in-flight chat fetch without executing tools or history writes', async () => {
  fakeTime();
  const parent = new AbortController();
  m.fetch
    .mockResolvedValueOnce(asr())
    .mockImplementationOnce(() => new Promise(() => {}));
  const result = observe(
    runEsp32AiProvider({ ...input, ...{ signal: parent.signal } })
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(m.fetch).toHaveBeenCalledTimes(2);
  parent.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ name: 'AbortError' });
  expect(m.fetch.mock.calls[1][1].signal.aborted).toBe(true);
  expect(m.execute).not.toHaveBeenCalled();
  expect(m.append).not.toHaveBeenCalled();
});
it('awaits a started tool receipt after cancellation, then stops without replaying or starting the next tool', async () => {
  fakeTime();
  const parent = new AbortController();
  const receipt = deferred<unknown>();
  m.fetch
    .mockResolvedValueOnce(asr())
    .mockResolvedValueOnce(toolReply())
    .mockResolvedValue(reply());
  m.execute.mockReturnValueOnce(receipt.promise);
  const result = observe(
    runEsp32AiProvider({ ...input, ...{ signal: parent.signal } })
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(m.execute).toHaveBeenCalledTimes(1);
  parent.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result.settled).toBe(false);
  receipt.resolve({
    ok: true,
    display: 'saved',
    data: {
      action: {
        type: 'notebook_note_created',
        note_id: 'accepted-once',
        title: 'synthetic',
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ name: 'AbortError' });
  expect(m.execute).toHaveBeenCalledTimes(1);
  expect(m.fetch).toHaveBeenCalledTimes(2);
  expect(m.append).not.toHaveBeenCalled();
});
it('cancellation at chat JSON completion cannot append conversation history', async () => {
  const parent = new AbortController();
  m.fetch.mockResolvedValueOnce(asr()).mockResolvedValueOnce({
    ok: true,
    json: async () => {
      parent.abort();
      return { choices: [{ message: { content: 'late synthetic reply' } }] };
    },
  });
  const result = observe(
    runEsp32AiProvider({ ...input, ...{ signal: parent.signal } })
  );
  await vi.waitFor(() => expect(result.settled).toBe(true));
  expect(result.error).toMatchObject({ name: 'AbortError' });
  expect(m.append).not.toHaveBeenCalled();
});

it('a stalled ASR JSON body is bounded and staged audio is cleaned at the deadline', async () => {
  fakeTime();
  vi.stubEnv('WQN_ESP32_AI_ASR_PROVIDER', 'dashscope');
  const json = deferred<unknown>();
  m.fetch.mockResolvedValueOnce({ ok: true, json: () => json.promise });
  const result = observe(runEsp32VoiceTranscription(input));
  await vi.advanceTimersByTimeAsync(50);
  expect(result.error).toMatchObject({ code: 'asr_timeout' });
  expect(m.cleanup).toHaveBeenCalledTimes(1);
  json.resolve({ output: { task_id: 'late-task' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(m.fetch).toHaveBeenCalledTimes(1);
  expect(m.cleanup).toHaveBeenCalledTimes(1);
});

it('successive chat rounds share one deadline', async () => {
  fakeTime();
  m.fetch
    .mockResolvedValueOnce(asr())
    .mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve(toolReply()), 35))
    )
    .mockImplementationOnce(() => new Promise(() => {}));
  const result = observe(runEsp32AiProvider(input));
  await vi.advanceTimersByTimeAsync(50);
  expect(result.error).toMatchObject({ code: 'chat_timeout', status: 504 });
  expect(m.fetch).toHaveBeenCalledTimes(3);
  expect(m.fetch.mock.calls[2][1].signal.aborted).toBe(true);
  expect(m.execute).toHaveBeenCalledTimes(2);
  expect(m.append).not.toHaveBeenCalled();
});

it('an elapsed chat deadline waits for the dispatched write receipt and never dispatches the next tool', async () => {
  fakeTime();
  const receipt = deferred<unknown>();
  m.fetch
    .mockResolvedValueOnce(asr())
    .mockResolvedValueOnce(toolReply())
    .mockResolvedValue(reply());
  m.execute.mockReturnValueOnce(receipt.promise);
  const result = observe(runEsp32AiProvider(input));
  await vi.advanceTimersByTimeAsync(50);
  expect(result.settled).toBe(false);
  expect(m.execute).toHaveBeenCalledTimes(1);
  receipt.resolve({
    ok: true,
    data: {
      action: {
        type: 'notebook_note_created',
        note_id: 'accepted-once',
        title: 'synthetic',
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ code: 'chat_timeout', status: 504 });
  expect(m.execute).toHaveBeenCalledTimes(1);
  expect(m.fetch).toHaveBeenCalledTimes(2);
  expect(m.append).not.toHaveBeenCalled();
});

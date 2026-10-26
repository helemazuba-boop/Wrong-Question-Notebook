import {
  createSseResponse,
  SseEventIdGenerator,
  type SseWriter,
} from '@/lib/ai-stream';
import {
  createVoiceOperation,
  combineVoiceSignals,
  VoiceOperationStopped,
} from '@/lib/voice-operation';
import {
  runStreamingPipeline,
  type RunStreamingPipelineOptions,
} from '@/lib/sse-pipeline';
import {
  runPipelineAsr,
  fetchJsonWithTimeout,
  type AsrConfig,
} from '@/lib/sse-pipeline-asr';
import { runPipelineChat, type ToolExecutor } from '@/lib/sse-pipeline-chat';
import { PipelinePusher } from '@/lib/sse-pipeline-types';

const staging = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {}),
  stage: vi.fn(),
}));
vi.mock('@/lib/esp32-ai-audio-staging', async original => ({
  ...(await original<typeof import('@/lib/esp32-ai-audio-staging')>()),
  stageEsp32AiAudioFile: staging.stage,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}
const audio = new Int16Array(32000).fill(5000).buffer;
const asrConfig: AsrConfig = {
  asrProvider: 'stepfun',
  asrFallbackProvider: null,
  asrTimeoutMs: 1000,
  dashScopeApiKey: 'fixture',
  asrTaskUrl: 'https://fixture.invalid/tasks',
  asrTaskStatusBaseUrl: 'https://fixture.invalid/tasks',
  asrModel: 'fixture',
  asrLanguageHints: [],
  asrPollIntervalMs: 60,
  asrPollAttempts: 10,
  audioUrlTtlMs: 10000,
  publicBaseUrl: 'https://fixture.invalid',
  stepfunApiKey: 'fixture',
  stepfunAsrUrl: 'https://fixture.invalid/asr',
  stepfunAsrModel: 'fixture',
  stepfunAsrLanguage: 'zh',
  stepfunAsrHotwords: [],
  stepfunAsrEnableItn: true,
};
const fetchMock = vi.fn();
function asrResponse() {
  return new Response(
    'data: {"type":"transcript.text.done","text":"fixture"}\n\n'
  );
}
function toolResponse(name = 'create_notebook_note') {
  return new Response(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-1', function: { name, arguments: '{}' } },
                { index: 1, id: 'call-2', function: { name, arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) +
      '\n\n'
  );
}
function makePusher(signal?: AbortSignal, onEmit?: (event: string) => void) {
  const events: Array<{ event: string; data: any }> = [];
  const writer = {
    signal,
    emit(event: string, data: any) {
      events.push({ event, data });
      onEmit?.(event);
      return 1;
    },
  } as SseWriter;
  return {
    pusher: new PipelinePusher(writer, new SseEventIdGenerator(), Date.now()),
    events,
  };
}
function startPipeline(
  extra: Partial<RunStreamingPipelineOptions> = {},
  parent?: AbortController,
  onEmit?: (event: string) => void
) {
  const done = deferred<{ result?: unknown; error?: unknown }>();
  const response = createSseResponse(
    async writer => {
      const emit = writer.emit.bind(writer);
      writer.emit = (event, data, opts) => {
        const result = emit(event, data, opts);
        onEmit?.(event);
        return result;
      };
      try {
        const result = await runStreamingPipeline({
          ...asrConfig,
          writer,
          input: {
            audio,
            sampleRate: 16000,
            channels: 1,
            sampleFormat: 's16le',
          },
          chatModelStd: 'fixture',
          chatModelPro: 'fixture',
          openAiBaseUrlStd: 'https://fixture.invalid',
          openAiBaseUrlPro: 'https://fixture.invalid',
          chatApiKeyStd: 'fixture',
          chatApiKeyPro: 'fixture',
          llmTimeoutMs: 1000,
          systemPrompt: 'fixture',
          ...extra,
        });
        done.resolve({ result });
      } catch (error) {
        done.resolve({ error });
      }
    },
    { signal: parent?.signal }
  );
  return { response, done: done.promise };
}
function fakeTime() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  staging.stage.mockResolvedValue({
    url: 'https://fixture.invalid/audio.wav',
    cleanup: staging.cleanup,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('consumer cancellation before the factory starts does no work', async () => {
  const factory = vi.fn(async () => {});
  const response = createSseResponse(factory);
  await response.body!.cancel();
  await Promise.resolve();
  expect(factory).not.toHaveBeenCalled();
});

it('cancels during a real ASR request and never starts chat or fallback', async () => {
  const started = deferred<AbortSignal>();
  fetchMock.mockImplementation((_url, init) => {
    started.resolve(init.signal);
    return new Promise(() => {});
  });
  const turn = startPipeline({ asrFallbackProvider: 'dashscope' });
  const signal = await started.promise;
  await turn.response.body!.cancel();
  expect((await turn.done).error).toBeInstanceOf(VoiceOperationStopped);
  expect(signal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(staging.stage).not.toHaveBeenCalled();
});

it('request abort cancels the ASR response reader as well as closing SSE', async () => {
  const cancelled = vi.fn();
  const entered = deferred<void>();
  fetchMock.mockImplementation(() => {
    entered.resolve();
    return Promise.resolve(
      new Response(new ReadableStream({ cancel: cancelled }))
    );
  });
  const parent = new AbortController();
  const turn = startPipeline({}, parent);
  await entered.promise;
  // Let the returned response enter the reader before aborting the request.
  await new Promise(resolve => setTimeout(resolve, 0));
  parent.abort();
  expect((await turn.done).error).toBeInstanceOf(VoiceOperationStopped);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('cancellation at asr.complete prevents the next stage', async () => {
  fetchMock.mockResolvedValue(asrResponse());
  const parent = new AbortController();
  const turn = startPipeline({}, parent, event => {
    if (event === 'asr.complete') parent.abort();
  });
  expect((await turn.done).error).toBeInstanceOf(VoiceOperationStopped);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('the turn deadline bounds an ASR fetch that ignores cancellation in the stub', async () => {
  fakeTime();
  const entered = deferred<void>();
  fetchMock.mockImplementation(() => {
    entered.resolve();
    return new Promise(() => {});
  });
  const turn = startPipeline({ turnTimeoutMs: 50 });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(50);
  expect((await turn.done).error).toMatchObject({ code: 'asr_timeout' });
  expect(await turn.response.text()).toContain('asr_timeout');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('poll waits and requests share a single ASR budget', async () => {
  fakeTime();
  fetchMock.mockImplementation((_url, init) =>
    Promise.resolve(
      Response.json(
        init.method === 'POST'
          ? { output: { task_id: 'task' } }
          : { output: { task_status: 'RUNNING' } }
      )
    )
  );
  const { pusher } = makePusher();
  const outcome = runPipelineAsr(
    { ...asrConfig, asrProvider: 'dashscope', asrTimeoutMs: 100 },
    audio,
    16000,
    1,
    pusher
  ).then(
    result => ({ result }),
    error => ({ error })
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toMatchObject({ error: { code: 'asr_timeout' } });
  expect(fetchMock).toHaveBeenCalledTimes(3); // submit, poll at 0, poll at 60.
  expect(staging.cleanup).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('fallback uses the primary remaining budget rather than another full allowance', async () => {
  fakeTime();
  fetchMock.mockImplementation((url, init) => {
    if (String(url).endsWith('/asr'))
      return new Promise(resolve =>
        setTimeout(
          () => resolve(new Response('unavailable', { status: 503 })),
          60
        )
      );
    return Promise.resolve(
      Response.json(
        init.method === 'POST'
          ? { output: { task_id: 'task' } }
          : { output: { task_status: 'RUNNING' } }
      )
    );
  });
  const { pusher } = makePusher();
  const outcome = runPipelineAsr(
    { ...asrConfig, asrTimeoutMs: 100, asrFallbackProvider: 'dashscope' },
    audio,
    16000,
    1,
    pusher
  ).then(
    result => ({ result }),
    error => ({ error })
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toMatchObject({ error: { code: 'asr_timeout' } });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(staging.cleanup).toHaveBeenCalledOnce();
});

it('the HTTP JSON body remains inside the timeout and honors a parent signal', async () => {
  fakeTime();
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementation((_url, init) => {
    signal = init.signal;
    return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
  });
  const outcome = fetchJsonWithTimeout(
    'https://fixture.invalid',
    { signal: parent.signal },
    1000,
    'asr'
  ).then(
    result => ({ result }),
    error => ({ error })
  );
  await vi.advanceTimersByTimeAsync(1);
  parent.abort();
  expect(await outcome).toMatchObject({ error: { reason: 'cancelled' } });
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('time budgets ignore wall-clock jumps and child budgets cannot extend the parent', async () => {
  fakeTime();
  const parent = createVoiceOperation(100);
  const combined = combineVoiceSignals(
    parent.signal,
    new AbortController().signal
  );
  await vi.advanceTimersByTimeAsync(40);
  const child = createVoiceOperation(500, combined);
  expect(child.remainingMs()).toBe(60);
  vi.setSystemTime(new Date('2035-01-01'));
  expect(parent.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(60);
  expect(parent.signal.aborted).toBe(true);
  expect(child.signal.aborted).toBe(true);
  child.dispose();
  parent.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('a started write survives consumer cancellation and its receipt skips further tools and narration', async () => {
  fetchMock.mockResolvedValue(toolResponse());
  const parent = new AbortController();
  const entered = deferred<Parameters<ToolExecutor>[2]>();
  const written = deferred<Awaited<ReturnType<ToolExecutor>>>();
  const execute = vi.fn<ToolExecutor>((_name, _args, meta) => {
    entered.resolve(meta);
    return written.promise;
  });
  const { pusher, events } = makePusher(parent.signal);
  const outcome = runPipelineChat(
    {
      apiKey: 'fixture',
      baseUrl: 'https://fixture.invalid',
      model: 'fixture',
      systemPrompt: 'fixture',
      llmTimeoutMs: 1000,
      signal: parent.signal,
    },
    { transcript: 'fixture' },
    pusher,
    execute
  );
  const meta = await entered.promise;
  parent.abort();
  expect(meta?.writeSignal?.aborted).toBe(false);
  written.resolve({
    ok: true,
    display: 'Note saved',
    action: { note_id: 'saved' },
  });
  const result = await outcome;
  expect(result.actions).toEqual([{ note_id: 'saved' }]);
  expect(result.functionCalls).toEqual([
    {
      name: 'create_notebook_note',
      status: 'succeeded',
      display: 'Note saved',
    },
  ]);
  expect(result.replyText).toBe('Note saved');
  expect(execute).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(events.find(e => e.event === 'tool.result')?.data).toMatchObject({
    tool_call_id: 'call-1',
    ok: true,
  });
});

it('a write without a receipt at deadline returns unknown_outcome without retry or a success claim', async () => {
  fakeTime();
  fetchMock.mockResolvedValue(toolResponse());
  const written = deferred<Awaited<ReturnType<ToolExecutor>>>();
  const entered = deferred<Parameters<ToolExecutor>[2]>();
  const execute = vi.fn<ToolExecutor>((_name, _args, meta) => {
    entered.resolve(meta);
    return written.promise;
  });
  const { pusher, events } = makePusher();
  const outcome = runPipelineChat(
    {
      apiKey: 'fixture',
      baseUrl: 'https://fixture.invalid',
      model: 'fixture',
      systemPrompt: 'fixture',
      llmTimeoutMs: 100,
    },
    { transcript: 'fixture' },
    pusher,
    execute
  );
  const meta = await entered.promise;
  await vi.advanceTimersByTimeAsync(100);
  const result = await outcome;
  expect(meta?.writeSignal?.aborted).toBe(true);
  expect(result.actions).toEqual([]);
  expect(result.replyText).toBe('Write result pending confirmation');
  expect(events.find(e => e.event === 'tool.result')?.data).toMatchObject({
    ok: false,
    error_code: 'unknown_outcome',
  });
  written.resolve({ ok: true, display: 'late receipt' });
  await Promise.resolve();
  expect(execute).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('read-only tools are cancellable without manufacturing a failed write receipt', async () => {
  fetchMock.mockResolvedValue(toolResponse('get_problem_detail'));
  const parent = new AbortController();
  const entered = deferred<Parameters<ToolExecutor>[2]>();
  const execute = vi.fn<ToolExecutor>((_name, _args, meta) => {
    entered.resolve(meta);
    return new Promise(() => {});
  });
  const { pusher, events } = makePusher(parent.signal);
  const outcome = runPipelineChat(
    {
      apiKey: 'fixture',
      baseUrl: 'https://fixture.invalid',
      model: 'fixture',
      systemPrompt: 'fixture',
      llmTimeoutMs: 1000,
      signal: parent.signal,
    },
    { transcript: 'fixture' },
    pusher,
    execute
  ).then(
    result => ({ result }),
    error => ({ error })
  );
  const meta = await entered.promise;
  parent.abort();
  expect(await outcome).toMatchObject({ error: { reason: 'cancelled' } });
  expect(meta?.signal?.aborted).toBe(true);
  expect(events.some(e => e.event === 'tool.result')).toBe(false);
  expect(execute).toHaveBeenCalledOnce();
});

it('a stop delivered at tool.start prevents invoking the executor', async () => {
  fetchMock.mockResolvedValue(toolResponse());
  const parent = new AbortController();
  const execute = vi.fn<ToolExecutor>();
  const { pusher } = makePusher(parent.signal, event => {
    if (event === 'tool.start') parent.abort();
  });
  await expect(
    runPipelineChat(
      {
        apiKey: 'fixture',
        baseUrl: 'https://fixture.invalid',
        model: 'fixture',
        systemPrompt: 'fixture',
        llmTimeoutMs: 1000,
        signal: parent.signal,
      },
      { transcript: 'fixture' },
      pusher,
      execute
    )
  ).rejects.toBeInstanceOf(VoiceOperationStopped);
  expect(execute).not.toHaveBeenCalled();
});

it('cancels an active LLM response reader without starting a tool', async () => {
  const parent = new AbortController();
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  fetchMock.mockResolvedValue(new Response(stream));
  const execute = vi.fn<ToolExecutor>();
  const { pusher } = makePusher(parent.signal);
  const outcome = runPipelineChat(
    {
      apiKey: 'fixture',
      baseUrl: 'https://fixture.invalid',
      model: 'fixture',
      systemPrompt: 'fixture',
      llmTimeoutMs: 1000,
      signal: parent.signal,
    },
    { transcript: 'fixture' },
    pusher,
    execute
  ).catch(error => error);
  await vi.waitFor(() => expect(stream.locked).toBe(true));
  parent.abort();
  expect(await outcome).toBeInstanceOf(VoiceOperationStopped);
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it('multiple model/tool rounds consume one chat budget and preserve receipts at expiry', async () => {
  fakeTime();
  fetchMock.mockImplementation(
    () => new Promise(resolve => setTimeout(() => resolve(toolResponse()), 40))
  );
  const execute = vi.fn<ToolExecutor>(async (_name, _args, meta) => ({
    ok: true,
    display: 'Note saved',
    action: { note_id: meta!.callId },
  }));
  const { pusher, events } = makePusher();
  const outcome = runPipelineChat(
    {
      apiKey: 'fixture',
      baseUrl: 'https://fixture.invalid',
      model: 'fixture',
      systemPrompt: 'fixture',
      llmTimeoutMs: 100,
    },
    { transcript: 'fixture' },
    pusher,
    execute
  ).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toMatchObject({ code: 'chat_timeout' });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(execute).toHaveBeenCalledTimes(4);
  expect(events.filter(event => event.event === 'tool.result')).toHaveLength(4);
  // Settle the simulated provider that intentionally ignores AbortSignal.
  await vi.advanceTimersByTimeAsync(20);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(execute).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

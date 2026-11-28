import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runStepFunAsrSse, type StepFunAsrConfig } from '@/lib/stepfun-asr';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const config: StepFunAsrConfig = {
  stepfunApiKey: 'fixture-key',
  stepfunAsrUrl: 'https://fixture.invalid/asr',
  stepfunAsrModel: 'stepaudio-2.5-asr',
  stepfunAsrLanguage: 'zh',
  stepfunAsrHotwords: [],
  stepfunAsrEnableItn: true,
  asrTimeoutMs: 1000,
};
const audio = new Int16Array(48000).fill(5000).buffer;
const fetchMock = vi.fn();
const encoder = new TextEncoder();
// This is the application's response budget, independent of audio upload size.
const responseBudget = 1024 * 1024;

function stream(chunks: Uint8Array[], cancel = vi.fn()) {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(chunks.shift()!);
        if (!chunks.length) controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 }
  );
  return { body, cancel, pulls: () => pulls };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('StepFun response ownership', () => {
  it.each(['resolved', 'rejected', 'pending'])(
    'cancels a provider error stream without waiting for %s cancellation',
    async outcome => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      const cancelled = vi.fn(() =>
        outcome === 'pending'
          ? new Promise<void>(() => {})
          : outcome === 'rejected'
            ? Promise.reject(new Error('synthetic cancel failure'))
            : Promise.resolve()
      );
      fetchMock.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"error","message":"synthetic ASR failure"}\n\n'
                )
              );
            },
            cancel: cancelled,
          })
        )
      );
      const outcomePromise = runStepFunAsrSse(config, audio, 16000, 1).catch(
        error => error
      );
      await vi.advanceTimersByTimeAsync(0);
      const error = await outcomePromise;
      expect(error).toMatchObject({
        code: 'asr_failed',
        message: 'synthetic ASR failure',
      });
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['single oversized chunk', 'many complete events'])(
    'bounds the total SSE response with %s and stops reading',
    async kind => {
      const chunks =
        kind === 'single oversized chunk'
          ? [
              new Uint8Array(responseBudget + 1).fill(120),
              encoder.encode('unused'),
            ]
          : Array.from({ length: 66 }, () =>
              encoder.encode(':' + 'x'.repeat(16381) + '\n\n')
            );
      const response = stream(chunks);
      fetchMock.mockResolvedValueOnce(new Response(response.body));
      await expect(
        runStepFunAsrSse(config, audio, 16000, 1)
      ).rejects.toMatchObject({
        code: 'asr_failed',
        message: 'StepFun ASR response exceeds byte limit',
      });
      expect(response.cancel).toHaveBeenCalledTimes(1);
      expect(response.pulls()).toBe(kind === 'single oversized chunk' ? 1 : 65);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts exactly the response budget and preserves split UTF-8 and CRLF', async () => {
    const event =
      'data: {"type":"transcript.text.done","text":"你好","meta":{"session_id":"final-id"}}\r\n\r\n';
    const padding =
      ':' +
      'x'.repeat(responseBudget - encoder.encode(event).byteLength - 3) +
      '\n\n';
    const bytes = encoder.encode(padding + event);
    expect(bytes.byteLength).toBe(responseBudget);
    const split = Buffer.from(bytes).indexOf(Buffer.from('你')) + 1;
    const response = stream([
      bytes.subarray(0, split),
      bytes.subarray(split, split + 1),
      bytes.subarray(split + 1),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(response.body));
    await expect(
      runStepFunAsrSse(config, audio, 16000, 1)
    ).resolves.toMatchObject({
      transcript: '你好',
      requestId: 'final-id',
    });
    expect(response.pulls()).toBe(3);
    expect(response.cancel).not.toHaveBeenCalled();
  });
});

describe('StepFun HTTP error preview', () => {
  it('reads a bounded preview and cancels the remaining HTTP error body', async () => {
    const response = stream([
      encoder.encode('diagnostic prefix ' + 'x'.repeat(8192)),
      encoder.encode('UNREAD_TAIL'),
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(response.body, { status: 503 })
    );
    const error = await runStepFunAsrSse(config, audio, 16000, 1).catch(
      error => error
    );
    expect(error).toMatchObject({ code: 'provider_unavailable', status: 502 });
    expect(error.message).toBe(
      'StepFun ASR HTTP 503 ' +
        ('diagnostic prefix ' + 'x'.repeat(8192)).slice(0, 200)
    );
    expect(error.message).not.toContain('UNREAD_TAIL');
    expect(response.pulls()).toBe(1);
    expect(response.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTP status when the error body and its cancellation never finish', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('x'.repeat(4096)));
          },
          cancel: cancelled,
        }),
        { status: 503 }
      )
    );
    const result = runStepFunAsrSse(
      { ...config, asrTimeoutMs: 25 },
      audio,
      16000,
      1
    ).catch(error => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({
      code: 'provider_unavailable',
      status: 502,
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'caller abort'])(
    'cancels a stalled HTTP error body on %s',
    async reason => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      const cancelled = vi.fn();
      const parent = new AbortController();
      fetchMock.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: cancelled }), { status: 503 })
      );
      const result = runStepFunAsrSse(
        { ...config, signal: parent.signal, asrTimeoutMs: 25 },
        audio,
        16000,
        1
      ).catch(error => error);
      await vi.advanceTimersByTimeAsync(0);
      if (reason === 'caller abort') parent.abort();
      else await vi.advanceTimersByTimeAsync(50);
      const error = await result;
      expect(error).toMatchObject(
        reason === 'deadline'
          ? { code: 'asr_timeout', status: 504 }
          : { name: 'AbortError' }
      );
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isLikelyNonSpeechPcm,
  runStepFunAsrSse,
  type StepFunAsrConfig,
} from '@/lib/stepfun-asr';

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
  },
}));

const mockFetch = vi.fn();

const baseConfig: StepFunAsrConfig = {
  stepfunApiKey: 'test-key',
  stepfunAsrUrl: 'https://asr.example.com/v1/asr',
  stepfunAsrModel: 'stepaudio-2.5-asr',
  stepfunAsrLanguage: 'zh',
  stepfunAsrHotwords: [],
  stepfunAsrEnableItn: true,
  asrTimeoutMs: 5000,
};

// Constant-amplitude pcm_s16le mono; rms equals the amplitude.
function pcmBuffer(seconds: number, amplitude: number): ArrayBuffer {
  const sampleCount = Math.round(seconds * 16000);
  const buffer = new ArrayBuffer(sampleCount * 2);
  const view = new Int16Array(buffer);
  for (let i = 0; i < sampleCount; i++) {
    view[i] = amplitude;
  }
  return buffer;
}

function sseResponse(lines: string[]): {
  ok: true;
  status: 200;
  body: ReadableStream<Uint8Array>;
} {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.join('\n')));
        controller.close();
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isLikelyNonSpeechPcm', () => {
  it('classifies clips shorter than 1.5s as non-speech', () => {
    expect(isLikelyNonSpeechPcm(pcmBuffer(0.5, 10000))).toBe(true);
  });

  it('classifies near-silence as non-speech regardless of duration', () => {
    expect(isLikelyNonSpeechPcm(pcmBuffer(4, 50))).toBe(true);
  });

  it('classifies audible clips of utterance length as speech', () => {
    expect(isLikelyNonSpeechPcm(pcmBuffer(3, 5000))).toBe(false);
  });

  it('classifies an empty buffer as non-speech', () => {
    expect(isLikelyNonSpeechPcm(new ArrayBuffer(0))).toBe(true);
  });
});

describe('runStepFunAsrSse empty-transcript classification', () => {
  it('maps an empty transcript on a short clip to no_speech 422', async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([': keepalive', '', '']));

    await expect(
      runStepFunAsrSse(baseConfig, pcmBuffer(0.5, 8000), 16000, 1)
    ).rejects.toMatchObject({ code: 'no_speech', status: 422 });
  });

  it('maps an empty transcript on a near-silent clip to no_speech 422', async () => {
    mockFetch.mockResolvedValueOnce(sseResponse(['']));

    await expect(
      runStepFunAsrSse(baseConfig, pcmBuffer(4, 30), 16000, 1)
    ).rejects.toMatchObject({ code: 'no_speech', status: 422 });
  });

  it('keeps an empty transcript on a real utterance as asr_failed 500', async () => {
    mockFetch.mockResolvedValueOnce(sseResponse(['']));

    await expect(
      runStepFunAsrSse(baseConfig, pcmBuffer(3, 5000), 16000, 1)
    ).rejects.toMatchObject({ code: 'asr_failed', status: 500 });
  });

  it('logs event and audio diagnostics when a done event carries no text', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"transcript.text.done","text":"","meta":{"session_id":"s-empty"}}',
        '',
        '',
      ])
    );

    await expect(
      runStepFunAsrSse(baseConfig, pcmBuffer(3, 5000), 16000, 1)
    ).rejects.toMatchObject({ code: 'asr_failed', status: 500 });

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [message, errorArg, context] = loggerErrorMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(errorArg).toBeUndefined();
    expect(message).toBe('StepFun ASR returned an empty transcript');
    expect(context.events).toEqual({
      deltaCount: 0,
      doneCount: 1,
      doneTextLength: 0,
      errorEventCount: 0,
      unknownEventCount: 0,
      malformedEventCount: 0,
      noDataEventCount: 0,
    });
    expect(context.requestId).toBe('s-empty');
    // Constant-amplitude clip: rms/dcOffset both equal the amplitude.
    expect(context.audio).toMatchObject({
      durationMs: 3000,
      rms: 5000,
      peak: 5000,
      dcOffset: 5000,
      clipRatio: 0,
    });
  });

  it('counts unknown and malformed provider events in the failure summary', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"session.failed","detail":"boom"}',
        '',
        'data: not-json-at-all',
        '',
        '',
      ])
    );

    const error = await runStepFunAsrSse(
      baseConfig,
      pcmBuffer(3, 5000),
      16000,
      1
    ).catch((thrown: { code?: string; message?: string }) => thrown);

    expect(error.code).toBe('asr_failed');
    expect(error.message).toContain('unknown=1');
    expect(error.message).toContain('malformed=1');
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'StepFun ASR returned an empty transcript',
      undefined,
      expect.objectContaining({
        lastUnknownType: 'session.failed',
        unknownPayloadSample: '{"type":"session.failed","detail":"boom"}',
        malformedPayloadSample: 'not-json-at-all',
      })
    );
  });

  it('keeps provider no_speech error events mapped to 422', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"error","message":"no speech detected"}',
        '',
        '',
      ])
    );

    await expect(
      runStepFunAsrSse(baseConfig, pcmBuffer(3, 5000), 16000, 1)
    ).rejects.toMatchObject({ code: 'no_speech', status: 422 });
  });

  it('returns the transcript on success', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"transcript.text.delta","delta":"你"}',
        '',
        'data: {"type":"transcript.text.done","text":"你好","meta":{"session_id":"s1"}}',
        '',
        '',
      ])
    );

    const result = await runStepFunAsrSse(
      baseConfig,
      pcmBuffer(3, 5000),
      16000,
      1
    );
    expect(result.transcript).toBe('你好');
    expect(result.requestId).toBe('s1');
  });
});

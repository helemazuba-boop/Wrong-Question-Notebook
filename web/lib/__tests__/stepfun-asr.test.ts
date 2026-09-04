import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isLikelyNonSpeechPcm,
  runStepFunAsrSse,
  type StepFunAsrConfig,
} from '@/lib/stepfun-asr';

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

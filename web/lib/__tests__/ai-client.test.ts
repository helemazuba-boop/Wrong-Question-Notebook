import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONSTANTS } from '@/lib/constants';
import { AIClientTimeoutError, createAIClient } from '@/lib/ai/client';

function openAiConstants(timeoutMs: number) {
  return {
    ...AI_CONSTANTS,
    PROVIDER: 'openai',
    REQUEST_TIMEOUT_MS: timeoutMs,
  } as typeof AI_CONSTANTS;
}

beforeEach(() => {
  process.env.AI_PROVIDER_BASE_URL = 'https://provider.invalid/v1';
  process.env.AI_PROVIDER_API_KEY = 'test-key';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.AI_PROVIDER_BASE_URL;
  delete process.env.AI_PROVIDER_API_KEY;
});

describe('AI client request deadline', () => {
  it('rejects a hung provider call at the configured deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    const client = createAIClient(openAiConstants(1_000));

    const pending = client.generateContent({
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
    const rejection =
      expect(pending).rejects.toBeInstanceOf(AIClientTimeoutError);
    await vi.advanceTimersByTimeAsync(1_001);

    await rejection;
  });

  it('does not include an upstream response body in thrown errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('sensitive upstream diagnostic', { status: 500 })
        )
    );
    const client = createAIClient(openAiConstants(1_000));

    await expect(
      client.generateContent({
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      })
    ).rejects.toThrow('OpenAI-compatible API error 500');
    await expect(
      client.generateContent({
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      })
    ).rejects.not.toThrow('sensitive upstream diagnostic');
  });
});

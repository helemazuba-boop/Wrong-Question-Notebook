import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONSTANTS } from '@/lib/constants';
import { createAIClient } from '@/lib/ai/client';

const constants = {
  ...AI_CONSTANTS,
  PROVIDER: 'anthropic',
  REQUEST_TIMEOUT_MS: 1_000,
} as typeof AI_CONSTANTS;

function messageResponse(content: unknown[]) {
  return Response.json({
    id: 'msg_contract_test',
    type: 'message',
    role: 'assistant',
    model: 'contract-test-model',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'contract-test-key');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://anthropic.invalid');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Anthropic SDK request contract', () => {
  it('preserves the API version, authentication and text-generation options', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(messageResponse([{ type: 'text', text: 'answer' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAIClient(constants).generateContent({
      model: 'contract-test-model',
      contents: [{ role: 'user', parts: [{ text: 'question' }] }],
      config: {
        systemInstruction: 'Be concise.',
        maxTokens: 128,
        temperature: 0.2,
      },
    });

    expect(result).toEqual({ text: 'answer' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(...fetchMock.mock.calls[0]);
    expect(request.url).toBe('https://anthropic.invalid/v1/messages');
    expect(request.method).toBe('POST');
    expect(request.headers.get('x-api-key')).toBe('contract-test-key');
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(await request.json()).toEqual({
      model: 'contract-test-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'question' }] },
      ],
      system: 'Be concise.',
      max_tokens: 128,
      temperature: 0.2,
    });
  });

  it('serializes image input and combines only text response blocks', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      messageResponse([
        { type: 'text', text: 'first' },
        { type: 'thinking', thinking: 'internal', signature: 'test' },
        { type: 'text', text: ' second' },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAIClient(constants).generateContent({
      model: 'contract-test-model',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Read this image.' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
          ],
        },
      ],
    });

    expect(result).toEqual({ text: 'first second' });
    const request = new Request(...fetchMock.mock.calls[0]);
    expect(await request.json()).toEqual({
      model: 'contract-test-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this image.' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'aW1hZ2U=',
              },
            },
          ],
        },
      ],
      max_tokens: 4096,
    });
  });

  it('propagates provider rejection instead of returning an empty answer', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Invalid input' },
        },
        { status: 400 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAIClient(constants).generateContent({
        model: 'contract-test-model',
        contents: [{ role: 'user', parts: [{ text: 'question' }] }],
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

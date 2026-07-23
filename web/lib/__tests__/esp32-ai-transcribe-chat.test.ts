import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_AUDIO_DURATION_MS,
  MAX_AUDIO_BODY_BYTES,
  POST,
} from '@/app/api/esp32/ai/transcribe-chat/route';

const mockMaybeSingle = vi.fn();
const mockSelectEq = vi.fn();
const mockSelect = vi.fn();
const mockUpdateEq = vi.fn();
const mockUpdate = vi.fn();
const mockUpsert = vi.fn();
const mockFrom = vi.fn();
const mockFetch = vi.fn();

let audioTmpDir: string | null = null;
let authDeviceCounter = 0;
const DEVICE_TOKEN = 'a'.repeat(64);

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({
    from: mockFrom,
  }),
}));

function createValidHeaders(overrides: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${DEVICE_TOKEN}`,
    'content-type': 'application/octet-stream',
    'x-wqn-audio-sample-rate': '16000',
    'x-wqn-audio-sample-format': 's16le',
    'x-wqn-audio-channels': '1',
    'x-wqn-audio-duration-ms': '1000',
    'user-agent': 'vitest',
    'x-forwarded-for': '127.0.0.1',
    ...overrides,
  };
}

function createAudioRequest(
  headers: Record<string, string>,
  body = Buffer.alloc(16000 * 2)
) {
  return new NextRequest('http://localhost/api/esp32/ai/transcribe-chat', {
    method: 'POST',
    headers,
    body,
  });
}

function mockAuthenticatedDevice() {
  authDeviceCounter += 1;
  mockMaybeSingle.mockResolvedValue({
    data: {
      id: `device-${authDeviceCounter}`,
      user_id: 'user-1',
      mac_address: 'AA:BB:CC:DD:EE:FF',
    },
    error: null,
  });
}

async function configureParaformerProvider() {
  audioTmpDir = await mkdtemp(join(tmpdir(), 'wqn-ai-test-'));
  process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
  process.env.DASHSCOPE_ASR_MODEL = 'paraformer-v2';
  process.env.SITE_URL = 'https://wqn.example.test';
  process.env.WQN_ESP32_AI_AUDIO_URL_SECRET = 'test-audio-secret';
  process.env.WQN_ESP32_AI_AUDIO_TMP_DIR = audioTmpDir;
  process.env.DASHSCOPE_ASR_POLL_INTERVAL_MS = '1';
  process.env.DASHSCOPE_ASR_POLL_ATTEMPTS = '2';
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WQN_ESP32_AI_ASR_PROVIDER;
  delete process.env.WQN_ESP32_AI_CHAT_PROVIDER;
  delete process.env.WQN_ESP32_AI_TRANSCRIBE_CHAT_MOCK;
  delete process.env.WQN_ESP32_AI_PUBLIC_BASE_URL;
  delete process.env.WQN_ESP32_AI_AUDIO_URL_SECRET;
  delete process.env.WQN_ESP32_AI_AUDIO_TMP_DIR;
  delete process.env.WQN_ESP32_AI_AUDIO_URL_TTL_MS;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_CHAT_API_KEY_STD;
  delete process.env.DASHSCOPE_CHAT_API_KEY_PRO;
  delete process.env.DASHSCOPE_OPENAI_BASE_URL;
  delete process.env.DASHSCOPE_OPENAI_BASE_URL_STD;
  delete process.env.DASHSCOPE_OPENAI_BASE_URL_PRO;
  delete process.env.DASHSCOPE_ASR_TASK_URL;
  delete process.env.DASHSCOPE_TASK_STATUS_BASE_URL;
  delete process.env.DASHSCOPE_ASR_MODEL;
  delete process.env.DASHSCOPE_ASR_LANGUAGE_HINTS;
  delete process.env.DASHSCOPE_ASR_POLL_INTERVAL_MS;
  delete process.env.DASHSCOPE_ASR_POLL_ATTEMPTS;
  delete process.env.DASHSCOPE_CHAT_MODEL;
  delete process.env.DASHSCOPE_CHAT_MODEL_STD;
  delete process.env.DASHSCOPE_CHAT_MODEL_PRO;
  delete process.env.STEPFUN_API_KEY;
  delete process.env.STEPFUN_ASR_URL;
  delete process.env.STEPFUN_ASR_MODEL;
  delete process.env.STEPFUN_ASR_LANGUAGE;
  delete process.env.STEPFUN_ASR_HOTWORDS;
  delete process.env.STEPFUN_ASR_ENABLE_ITN;
  delete process.env.WQN_ESP32_AI_PROVIDER_TIMEOUT_MS;
  delete process.env.SITE_URL;
  audioTmpDir = null;
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);

  mockFrom.mockReturnValue({
    select: mockSelect,
    update: mockUpdate,
    upsert: mockUpsert,
  });
  mockSelect.mockReturnValue({ eq: mockSelectEq });
  mockSelectEq.mockReturnValue({
    eq: mockSelectEq,
    maybeSingle: mockMaybeSingle,
  });
  mockUpdate.mockReturnValue({ eq: mockUpdateEq });
  mockUpdateEq.mockResolvedValue({ data: null, error: null });
  mockUpsert.mockResolvedValue({ data: null, error: null });
});

afterEach(async () => {
  if (audioTmpDir) {
    await rm(audioTmpDir, { recursive: true, force: true });
  }
});

describe('POST /api/esp32/ai/transcribe-chat', () => {
  it('returns 401 when the bearer token is missing', async () => {
    const { authorization: _authorization, ...headers } = createValidHeaders();

    const response = await POST(createAudioRequest(headers));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'unauthorized',
      },
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a malformed bearer token before querying the database', async () => {
    const response = await POST(
      createAudioRequest(
        createValidHeaders({ authorization: 'Bearer not-a-device-token' })
      )
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      success: false,
      error: { code: 'unauthorized' },
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns 415 for a wrong content type', async () => {
    mockAuthenticatedDevice();

    const response = await POST(
      createAudioRequest(
        createValidHeaders({ 'content-type': 'application/json' })
      )
    );
    const body = await response.json();

    expect(response.status).toBe(415);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'invalid_audio',
      },
    });
  });

  it('disables StepFun ASR when its API key is missing', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();
    process.env.WQN_ESP32_AI_ASR_PROVIDER = 'stepfun';

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('disabled');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 413 when the audio body is too large', async () => {
    mockAuthenticatedDevice();
    const bodyBytes = MAX_AUDIO_BODY_BYTES + 1;

    const response = await POST(
      createAudioRequest(
        createValidHeaders({ 'content-length': String(bodyBytes) }),
        Buffer.alloc(bodyBytes)
      )
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'too_large',
      },
    });
  });

  it('accepts the configured maximum audio duration and body size', async () => {
    mockAuthenticatedDevice();
    process.env.WQN_ESP32_AI_TRANSCRIBE_CHAT_MOCK = '1';

    const bodyBytes = MAX_AUDIO_BODY_BYTES - 4096;
    const response = await POST(
      createAudioRequest(
        createValidHeaders({
          'content-length': String(bodyBytes),
          'x-wqn-audio-duration-ms': String(MAX_AUDIO_DURATION_MS),
        }),
        Buffer.alloc(bodyBytes)
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('rejects audio longer than the configured maximum duration', async () => {
    mockAuthenticatedDevice();

    const response = await POST(
      createAudioRequest(
        createValidHeaders({
          'x-wqn-audio-duration-ms': String(MAX_AUDIO_DURATION_MS + 1),
        })
      )
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'invalid_audio',
      },
    });
  });

  it('returns disabled when ASR/chat env is not configured', async () => {
    mockAuthenticatedDevice();

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'disabled',
        message: 'ESP32 AI voice route is disabled',
      },
    });
  });

  it('returns mock success when the route mock is enabled', async () => {
    mockAuthenticatedDevice();
    process.env.WQN_ESP32_AI_TRANSCRIBE_CHAT_MOCK = '1';

    const response = await POST(
      createAudioRequest(
        createValidHeaders({ 'x-wqn-conversation-id': 'conv-1' })
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        transcript: 'mock transcript',
        reply_text: 'mock reply',
        conversation_id: 'conv-1',
        latency_ms: 0,
        asr: {
          provider: 'mock',
          model: 'mock',
          status: 'succeeded',
          text: 'mock transcript',
        },
        status_trace: [
          { stage: 'request', status: 'succeeded', elapsed_ms: 0 },
        ],
        function_calls: [],
        actions: [],
      },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('streams raw PCM with bounded thinking controls and reasoning events', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();

    const upstreamSse = [
      'data: {"id":"chat-stream-1","choices":[{"delta":{"reasoning_content":"先分析"},"finish_reason":null}]}',
      '',
      'data: {"id":"chat-stream-1","choices":[{"delta":{"content":"答案"},"finish_reason":null}]}',
      '',
      'data: {"id":"chat-stream-1","choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output: { task_id: 'task-v2' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ text: '请回答。' }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(upstreamSse));
            controller.close();
          },
        }),
      });

    const response = await POST(
      createAudioRequest(
        createValidHeaders({
          'x-wqn-protocol': 'v2-streaming',
          'x-wqn-ai-tier': 'pro',
          'x-wqn-enable-thinking': 'true',
          'x-wqn-reasoning-effort': 'high',
          'x-wqn-conversation-id': 'conv-v2',
        })
      )
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('event: thinking.start');
    expect(body).toContain('event: thinking.delta');
    expect(body).toContain('"delta":"先分析"');
    expect(body).toContain('event: thinking.done');
    expect(body).toContain('event: final');

    const chatBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(chatBody.enable_thinking).toBe(true);
    expect(chatBody.thinking_budget).toBe(8192);
    expect(chatBody.messages[0].content).toContain('validate key assumptions');
    expect(chatBody.messages.at(-1).content).toBe('请回答。');
  });

  it('rejects unbounded v2 thinking controls before provider calls', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();

    const response = await POST(
      createAudioRequest(
        createValidHeaders({
          'x-wqn-protocol': 'v2-streaming',
          'x-wqn-reasoning-effort': 'xhigh',
        })
      )
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe('invalid_audio');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stages PCM as a signed WAV URL, calls paraformer-v2, then calls chat', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'asr-submit-1',
          output: {
            task_id: 'task-1',
            task_status: 'PENDING',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'asr-query-1',
          output: {
            task_status: 'SUCCEEDED',
            results: [{ text: '今天复习什么？' }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'chat-request-1',
          choices: [
            {
              message: {
                content: '先复习到期错题。',
              },
            },
          ],
        }),
      });

    const response = await POST(
      createAudioRequest(
        createValidHeaders({ 'x-wqn-conversation-id': 'conv-1' })
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        transcript: '今天复习什么？',
        reply_text: '先复习到期错题。',
        conversation_id: 'conv-1',
        asr: {
          provider: 'dashscope',
          model: 'paraformer-v2',
          status: 'succeeded',
          text: '今天复习什么？',
          request_id: 'asr-submit-1',
        },
        function_calls: [],
      },
    });
    expect(body.data.status_trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'request', status: 'started' }),
        expect.objectContaining({ stage: 'audio_stage', status: 'started' }),
        expect.objectContaining({ stage: 'asr_submit', status: 'succeeded' }),
        expect.objectContaining({ stage: 'asr_poll', status: 'succeeded' }),
        expect.objectContaining({ stage: 'chat', status: 'succeeded' }),
        expect.objectContaining({ stage: 'request', status: 'succeeded' }),
      ])
    );
    expect(JSON.stringify(body)).not.toContain('test-audio-secret');
    expect(JSON.stringify(body)).not.toContain('/api/esp32/ai/audio-temp/');
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const [submitUrl, submitInit] = mockFetch.mock.calls[0];
    const [queryUrl, queryInit] = mockFetch.mock.calls[1];
    const [chatUrl, chatInit] = mockFetch.mock.calls[2];

    expect(submitUrl).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription'
    );
    expect(queryUrl).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/task-1');
    expect(chatUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    );
    expect(submitInit.headers.Authorization).toBe('Bearer test-dashscope-key');
    expect(queryInit.headers.Authorization).toBe('Bearer test-dashscope-key');

    const submitBody = JSON.parse(submitInit.body);
    expect(submitBody.model).toBe('paraformer-v2');
    expect(submitBody.input.file_urls).toHaveLength(1);
    expect(submitBody.input.file_urls[0]).toMatch(
      /^https:\/\/wqn\.example\.test\/api\/esp32\/ai\/audio-temp\/[0-9a-f-]+\?/
    );
    expect(submitBody.input.file_urls[0]).toContain('sig=');

    const chatBody = JSON.parse(chatInit.body);
    expect(chatBody.model).toBe('qwen-plus');
    expect(chatBody.messages[1].content).toContain('今天复习什么？');
  });

  it('returns simplified function call summaries without raw tool arguments', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'asr-submit-1',
          output: { task_id: 'task-1' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'asr-query-1',
          output: {
            task_status: 'SUCCEEDED',
            results: [{ text: '帮我调用不存在的工具。' }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'chat-request-1',
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'tool-call-1',
                    type: 'function',
                    function: {
                      name: 'unknown_tool',
                      arguments: '{"secret":"do-not-return"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'chat-request-2',
          choices: [{ message: { content: '这个工具不可用。' } }],
        }),
      });

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        transcript: '帮我调用不存在的工具。',
        reply_text: '这个工具不可用。',
        function_calls: [
          {
            name: 'unknown_tool',
            status: 'failed',
            display: '未知工具：unknown_tool',
          },
        ],
      },
    });
    expect(body.data.status_trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'function_call', status: 'started' }),
        expect.objectContaining({
          stage: 'function_call',
          status: 'succeeded',
        }),
      ])
    );
    expect(JSON.stringify(body)).not.toContain('do-not-return');
    expect(JSON.stringify(body)).not.toContain('tool-call-1');
  });

  it('maps DashScope ASR failures without exposing provider secrets', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: 'provider failure' }),
    });

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('provider_unavailable');
    expect(JSON.stringify(body)).not.toContain('test-dashscope-key');
    expect(JSON.stringify(body)).not.toContain('provider failure');
  });

  it('reads DashScope transcription_url results before calling chat', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'asr-submit-1',
          output: { task_id: 'task-url-1' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'asr-query-1',
          output: {
            task_status: 'SUCCEEDED',
            transcription_url: 'https://dashscope.example.test/result.json',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transcripts: [{ text: '今天复习数学。' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: 'chat-request-1',
          choices: [{ message: { content: '先看函数错题。' } }],
        }),
      });

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        transcript: '今天复习数学。',
        reply_text: '先看函数错题。',
      },
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[2][0]).toBe(
      'https://dashscope.example.test/result.json'
    );

    const chatBody = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(chatBody.messages[1].content).toContain(
      '用户语音转写：今天复习数学。'
    );
    expect(chatBody.messages[1].content).not.toContain('{transcript}');
  });

  it('maps DashScope no-speech ASR tasks to no_speech', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: { task_id: 'task-1' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_status: 'FAILED',
            code: 'NO_SPEECH',
            message: 'no speech detected',
          },
        }),
      });

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('no_speech');
  });

  it('maps DashScope chat failures to model failure', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: { task_id: 'task-1' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ text: '今天复习什么？' }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ message: 'chat failure' }),
      });

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('provider_unavailable');
    expect(JSON.stringify(body)).not.toContain('chat failure');
  });

  it('rejects non-paraformer ASR models for this ESP32 path', async () => {
    mockAuthenticatedDevice();
    await configureParaformerProvider();
    process.env.DASHSCOPE_ASR_MODEL = 'qwen3-asr-flash';

    const response = await POST(createAudioRequest(createValidHeaders()));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('disabled');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

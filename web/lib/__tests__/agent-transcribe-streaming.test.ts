import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/esp32/agent/transcribe/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  MAX_AUDIO_BODY_BYTES,
  MIN_PCM_AUDIO_BODY_BYTES,
} from '@/lib/esp32-ai-audio-contract';

const { authenticate, fetchMock } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/esp32-device-auth', () => ({
  authenticateEsp32Device: authenticate,
}));

const DEVICE_TOKEN = 'a'.repeat(64);

let audioTmpDir: string | null = null;

function audioHeaders(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    authorization: `Bearer ${DEVICE_TOKEN}`,
    'content-type': 'application/octet-stream',
    'x-wqn-audio-sample-rate': '16000',
    'x-wqn-audio-sample-format': 's16le',
    'x-wqn-audio-channels': '1',
    'x-wqn-audio-duration-ms': '1000',
    ...overrides,
  };
}

function streamingRequest(
  overrides: Record<string, string> = {},
  url = 'http://localhost/api/esp32/agent/transcribe'
) {
  return new NextRequest(url, {
    method: 'POST',
    headers: audioHeaders({ 'x-wqn-protocol': 'v2-streaming', ...overrides }),
    body: Buffer.alloc(16000 * 2),
  });
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

async function configureDashScopeProvider() {
  audioTmpDir = await mkdtemp(join(tmpdir(), 'wqn-agent-asr-test-'));
  process.env.WQN_ESP32_AI_ASR_PROVIDER = 'dashscope';
  process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
  process.env.SITE_URL = 'https://wqn.example.test';
  process.env.WQN_ESP32_AI_AUDIO_URL_SECRET = 'test-audio-secret';
  process.env.WQN_ESP32_AI_AUDIO_TMP_DIR = audioTmpDir;
  process.env.DASHSCOPE_ASR_POLL_INTERVAL_MS = '1';
  process.env.DASHSCOPE_ASR_POLL_ATTEMPTS = '2';
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  _resetRateLimitStore();
  vi.stubGlobal('fetch', fetchMock);
  authenticate.mockResolvedValue({ userId: 'user-a', deviceId: 'device-1' });

  delete process.env.WQN_ESP32_AI_ASR_PROVIDER;
  delete process.env.WQN_ESP32_AI_ASR_FALLBACK_PROVIDER;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_ASR_POLL_INTERVAL_MS;
  delete process.env.DASHSCOPE_ASR_POLL_ATTEMPTS;
  delete process.env.STEPFUN_API_KEY;
  delete process.env.STEPFUN_ASR_HOTWORDS;
  delete process.env.STEPFUN_ASR_ENABLE_ITN;
  delete process.env.WQN_ESP32_AI_AUDIO_URL_SECRET;
  delete process.env.WQN_ESP32_AI_AUDIO_TMP_DIR;
  delete process.env.WQN_ESP32_AGENT_TRANSCRIBE_MOCK;
  delete process.env.SITE_URL;
  audioTmpDir = null;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (audioTmpDir) {
    await rm(audioTmpDir, { recursive: true, force: true });
  }
});

describe('POST /api/esp32/agent/transcribe (v2-streaming branch)', () => {
  it.each([
    [
      'omitted length',
      undefined,
      () => MAX_AUDIO_BODY_BYTES + 1,
      413,
      'too_large',
    ],
    [
      'understated length',
      '32000',
      () => MAX_AUDIO_BODY_BYTES + 1,
      413,
      'too_large',
    ],
    ['empty body', undefined, () => 0, 422, 'invalid_audio'],
    [
      'short body',
      undefined,
      () => MIN_PCM_AUDIO_BODY_BYTES - 2,
      422,
      'invalid_audio',
    ],
  ] as const)(
    'rejects invalid streamed audio with %s before ASR',
    async (_, length, size, status, code) => {
      process.env.WQN_ESP32_AI_ASR_PROVIDER = 'stepfun';
      process.env.STEPFUN_API_KEY = 'test-stepfun-key';
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"type":"transcript.text.done","text":"fixture"}\n\n',
        ]),
      });
      const headers = audioHeaders({ 'x-wqn-protocol': 'v2-streaming' });
      if (length !== undefined) headers['content-length'] = length;
      const response = await POST(
        new NextRequest('http://localhost/api/esp32/agent/transcribe', {
          method: 'POST',
          headers,
          body: Buffer.alloc(size()),
        })
      );
      const body = await response.text();
      expect(response.status).toBe(status);
      expect(JSON.parse(body)).toMatchObject({
        success: false,
        error: { code },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('stops reading at the byte cap even when stream cancellation never settles', async () => {
    process.env.WQN_ESP32_AI_ASR_PROVIDER = 'stepfun';
    process.env.STEPFUN_API_KEY = 'test-stepfun-key';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"type":"transcript.text.done","text":"fixture"}\n\n',
      ]),
    });
    let pulls = 0;
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1)
            controller.enqueue(new Uint8Array(MAX_AUDIO_BODY_BYTES));
          else if (pulls === 2) controller.enqueue(new Uint8Array(2));
          else controller.close();
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 }
    );
    const response = await POST(
      new NextRequest('http://localhost/api/esp32/agent/transcribe', {
        method: 'POST',
        headers: audioHeaders({ 'x-wqn-protocol': 'v2-streaming' }),
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
    );
    expect(response.status).toBe(413);
    expect(pulls).toBe(2);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the device turn ID through the real ASR path into empty-result diagnostics', async () => {
    process.env.WQN_ESP32_AI_ASR_PROVIDER = 'stepfun';
    process.env.STEPFUN_API_KEY = 'test-stepfun-key';
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"type":"transcript.text.done","text":"","meta":{"session_id":"provider-empty-1"}}\n\n',
        ]),
      });
      const audio = Buffer.alloc(3 * 16000 * 2);
      for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(5000, i);
      const response = await POST(
        new NextRequest('http://localhost/api/esp32/agent/transcribe', {
          method: 'POST',
          headers: audioHeaders({
            'x-wqn-protocol': 'v2-streaming',
            'x-wqn-request-id': '77d7ecc1156db6f0',
            'x-wqn-audio-duration-ms': '3000',
          }),
          body: audio,
        })
      );
      const body = await response.text();
      expect(body).toContain('"turn_id":"77d7ecc1156db6f0"');
      expect(body).toContain('event: asr.failed');
      expect(body).not.toContain('event: asr.complete');
      expect(body).not.toContain('provider-empty-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        'StepFun ASR returned an empty transcript',
        undefined,
        expect.objectContaining({
          voiceTurnId: '77d7ecc1156db6f0',
          requestId: 'provider-empty-1',
          textFields: expect.objectContaining({
            lastDoneTextKind: 'empty_string',
          }),
          audio: expect.objectContaining({ pcmBytes: 96000, durationMs: 3000 }),
        })
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('streams StepFun deltas and closes with asr.complete + final', async () => {
    process.env.WQN_ESP32_AI_ASR_PROVIDER = 'stepfun';
    process.env.STEPFUN_API_KEY = 'test-stepfun-key';
    process.env.STEPFUN_ASR_HOTWORDS = '错题,复习';
    process.env.STEPFUN_ASR_ENABLE_ITN = 'false';

    const stepfunSse = [
      'data: {"type":"transcript.text.delta","delta":"你"}',
      '',
      'data: {"type":"transcript.text.delta","delta":"好"}',
      '',
      'data: {"type":"transcript.text.done","text":"你好","meta":{"session_id":"stepfun-1"}}',
      '',
      '',
    ].join('\n');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: sseStream([stepfunSse]),
    });

    const response = await POST(
      streamingRequest({ 'x-wqn-request-id': '0123456789abcdef' })
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('event: ready');
    expect(body).toContain('"turn_id":"0123456789abcdef"');
    expect(body).toContain('"ai_tier":"agent"');
    expect(body).toContain('event: asr.delta');
    expect(body).toContain('"delta":"你"');
    expect(body).toContain('event: asr.complete');
    expect(body).toContain('"text":"你好"');
    expect(body).toContain('"provider":"stepfun"');
    expect(body).toContain('event: final');
    expect(body).toContain('"transcript":"你好"');
    expect(body).not.toContain('event: asr.failed');

    // StepFun hotwords / ITN must flow through loadV2RuntimeConfig.
    const [stepfunUrl, stepfunInit] = fetchMock.mock.calls[0];
    expect(String(stepfunUrl)).toContain('stepfun');
    const stepfunBody = JSON.parse(stepfunInit.body);
    expect(stepfunBody.audio.input.transcription.hotwords).toEqual([
      '错题',
      '复习',
    ]);
    expect(stepfunBody.audio.input.transcription.enable_itn).toBe(false);
  });

  it('degrades to a single asr.complete for DashScope without deltas', async () => {
    await configureDashScopeProvider();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output: { task_id: 'task-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ text: '今天复习数学。' }],
          },
        }),
      });

    const response = await POST(streamingRequest());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('event: asr.delta');
    expect(body).toContain('event: asr.complete');
    expect(body).toContain('"text":"今天复习数学。"');
    expect(body).toContain('"provider":"dashscope"');
    expect(body).toContain('event: final');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('emits asr.failed and a terminal error frame when the provider fails', async () => {
    process.env.WQN_ESP32_AI_ASR_PROVIDER = 'stepfun';
    process.env.STEPFUN_API_KEY = 'test-stepfun-key';
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'upstream down',
    });

    const response = await POST(streamingRequest());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: asr.failed');
    expect(body).toContain('"error_code":"provider_unavailable"');
    expect(body).toContain('event: error');
    expect(body).toContain('"error_code":"provider_unavailable"');
    expect(body).not.toContain('event: final');
  });

  it('accepts ?protocol=v2-streaming and falls back to a generated turn_id', async () => {
    process.env.WQN_ESP32_AI_ASR_PROVIDER = 'stepfun';
    process.env.STEPFUN_API_KEY = 'test-stepfun-key';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: sseStream([
        [
          'data: {"type":"transcript.text.done","text":"查询参数路径。"}',
          '',
          '',
        ].join('\n'),
      ]),
    });

    const response = await POST(
      streamingRequest(
        {},
        'http://localhost/api/esp32/agent/transcribe?protocol=v2-streaming'
      )
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: ready');
    expect(body).toMatch(/"turn_id":"[0-9a-f-]{36}"/);
    expect(body).toContain('event: final');
    expect(body).toContain('"transcript":"查询参数路径。"');
  });

  it('keeps the one-shot JSON behavior without a streaming signal', async () => {
    process.env.WQN_ESP32_AGENT_TRANSCRIBE_MOCK = '1';

    const response = await POST(
      new NextRequest('http://localhost/api/esp32/agent/transcribe', {
        method: 'POST',
        headers: audioHeaders(),
        body: Buffer.alloc(16000 * 2),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { transcript: 'mock agent transcript', latency_ms: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a 60s batch upload at the PCM body ceiling', async () => {
    process.env.WQN_ESP32_AGENT_TRANSCRIBE_MOCK = '1';

    const response = await POST(
      new NextRequest('http://localhost/api/esp32/agent/transcribe', {
        method: 'POST',
        headers: audioHeaders({ 'x-wqn-audio-duration-ms': '60000' }),
        body: Buffer.alloc(16000 * 2 * 60),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { transcript: 'mock agent transcript', latency_ms: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a batch upload above the 60s PCM body ceiling', async () => {
    process.env.WQN_ESP32_AGENT_TRANSCRIBE_MOCK = '1';

    const response = await POST(
      new NextRequest('http://localhost/api/esp32/agent/transcribe', {
        method: 'POST',
        headers: audioHeaders({ 'x-wqn-audio-duration-ms': '60000' }),
        body: Buffer.alloc(16000 * 2 * 60 + 4098),
      })
    );

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

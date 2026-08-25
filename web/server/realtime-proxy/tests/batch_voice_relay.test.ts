import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { handleBatchVoiceConnection } from '../src/batchVoiceRelay.ts';
import { encodeWflvAudio } from '../src/frameIo.ts';
import { STD_PRO_SAMPLE_RATE_HZ } from '../src/types.ts';

class MockDeviceWs extends EventEmitter {
  public sent: string[] = [];
  public readyState = 1; // OPEN

  send(data: string | Buffer) {
    this.sent.push(typeof data === 'string' ? data : data.toString('utf8'));
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

describe('batchVoiceRelay', () => {
  const mockDevice = {
    userId: 'user-123',
    deviceId: 'device-456',
    macAddress: 'AA:BB:CC:DD:EE:FF',
  };

  const mockConfig = {
    bind: '0.0.0.0',
    port: 8080,
    upstream: { url: '', apiKey: 'dummy', model: '' },
    executeToolUrl: '',
    transcribeChatUrl:
      'http://localhost:3000/api/esp32/ai/transcribe-chat?protocol=v2-streaming',
    proxySecret: 'test-secret-123456789012345678901234',
    realtimeEnabled: true,
  };

  const mockReq = {
    headers: {
      authorization:
        'Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  } as any;

  it('negotiates session.ready on connection', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    expect(ws.sent.length).toBe(1);
    const ready = JSON.parse(ws.sent[0]);
    expect(ready).toMatchObject({
      type: 'session.ready',
      protocol: 'wqn-voice-v2',
      sample_rate_hz: 16000,
    });
  });

  it('rejects a second START while a turn is already active', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    // 1st START
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-turn-1',
          tier: 'std',
        })
      ),
      false
    );

    // 2nd START (rejected)
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-turn-2',
          tier: 'std',
        })
      ),
      false
    );

    expect(ws.sent.length).toBe(2);
    expect(ws.sent[1]).toContain('event: error');
    expect(ws.sent[1]).toContain('state_error');
  });

  it('rejects sequence gap during PCM upload', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    // START
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-turn-seq',
          tier: 'std',
        })
      ),
      false
    );

    // Chunk 0 (ok)
    const pcm = Buffer.alloc(480);
    const frame0 = encodeWflvAudio({
      pcm,
      seq: 0,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      streaming: true,
    });
    ws.emit('message', frame0, true);

    // Chunk 2 (gap! expected 1)
    const frame2 = encodeWflvAudio({
      pcm,
      seq: 2,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      streaming: true,
    });
    ws.emit('message', frame2, true);

    expect(ws.sent.some(s => s.includes('sequence_gap'))).toBe(true);
  });

  it('accumulates PCM and dispatches to Next.js on FINAL, safely decoding split UTF-8 SSE', async () => {
    const ws = new MockDeviceWs();

    // Mock fetch for Next.js transcribe-chat
    const sseChunks = [
      'event: ready\ndata: {"turn_id":"123"}\n\n',
      'event: asr.complete\ndata: {"text":"测试"}', // split across chunk boundary!
      '\n\nevent: text.delta\ndata: {"delta":"你"}',
      '\n\nevent: text.delta\ndata: {"delta":"好"}\n\n',
      'event: turn.done\ndata: {}\n\n',
    ];

    let bodySent: Buffer | null = null;
    let headersSent: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      bodySent = options.body;
      headersSent = options.headers;

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseChunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return {
        ok: true,
        body: stream,
      };
    });

    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    // START
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-full-test',
          tier: 'pro',
          conversation_id: 'conv-abc',
          enable_thinking: true,
          reasoning_effort: 'high',
        })
      ),
      false
    );

    // Send 3 PCM chunks (480 bytes each)
    const pcmChunk = Buffer.alloc(480, 0x12);
    for (let seq = 0; seq < 3; seq++) {
      const frame = encodeWflvAudio({
        pcm: pcmChunk,
        seq,
        sampleRate: STD_PRO_SAMPLE_RATE_HZ,
        streaming: true,
      });
      ws.emit('message', frame, true);
    }

    // Send FINAL frame
    const finalFrame = encodeWflvAudio({
      pcm: Buffer.alloc(0),
      seq: 3,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      final: true,
    });
    await ws.emit('message', finalFrame, true);

    // Wait for async reader
    await new Promise(res => setTimeout(res, 50));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(headersSent['X-WQN-Internal-Proxy-Authorization']).toBe(
      'Bearer test-secret-123456789012345678901234'
    );
    expect(headersSent['Authorization']).toBe(
      'Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
    expect(headersSent['x-wqn-ai-tier']).toBe('pro');
    expect(headersSent['x-wqn-conversation-id']).toBe('conv-abc');
    expect(headersSent['x-wqn-enable-thinking']).toBe('true');
    expect(headersSent['x-wqn-reasoning-effort']).toBe('high');

    // Total PCM length should be 3 * 480 = 1440 bytes
    expect(bodySent).not.toBeNull();
    expect((bodySent as unknown as Buffer).length).toBe(1440);

    // Check SSE stream received on device WS
    const textOutput = ws.sent.slice(1).join('');
    expect(textOutput).toContain('event: ready');
    expect(textOutput).toContain('event: asr.complete');
    expect(textOutput).toContain('"text":"测试"');
    expect(textOutput).toContain('event: text.delta');
    expect(textOutput).toContain('event: turn.done');
  });
});

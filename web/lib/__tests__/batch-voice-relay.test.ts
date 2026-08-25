import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { handleBatchVoiceConnection } from '../../server/realtime-proxy/src/batchVoiceRelay.ts';
import {
  encodeVoiceV2Audio,
  decodeVoiceV2Audio,
  decodeWflvAudio,
} from '../../server/realtime-proxy/src/frameIo.ts';
import { STD_PRO_SAMPLE_RATE_HZ } from '../../server/realtime-proxy/src/types.ts';

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
    const frame0 = encodeVoiceV2Audio({
      pcm,
      seq: 0,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      streaming: true,
    });
    ws.emit('message', frame0, true);

    // Chunk 2 (gap! expected 1)
    const frame2 = encodeVoiceV2Audio({
      pcm,
      seq: 2,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      streaming: true,
    });
    ws.emit('message', frame2, true);

    expect(ws.sent.some(s => s.includes('sequence_gap'))).toBe(true);
  });

  it('decodes firmware golden WFLV header with explicit W,F,L,V magic bytes', () => {
    // Exact byte layout emitted by firmware EncodeWflvHeader() for Voice v2
    const header = Buffer.alloc(24 + 480);
    header[0] = 0x57; // 'W'
    header[1] = 0x46; // 'F'
    header[2] = 0x4c; // 'L'
    header[3] = 0x56; // 'V'
    header.writeUInt16LE(2, 4); // version = 2
    header.writeUInt16LE(1, 6); // flags = kWflvFlagStream
    header.writeUInt32LE(42, 8); // seq = 42
    header.writeUInt32LE(16000, 12); // sample_rate = 16000
    header.writeUInt32LE(1, 16); // channels = 1
    header.writeUInt32LE(0, 20); // reserved = 0
    header.fill(0x5a, 24); // 480 bytes synthetic PCM

    const decoded = decodeVoiceV2Audio(header);
    expect(decoded).not.toBeNull();
    expect(decoded?.flags).toBe(1);
    expect(decoded?.seq).toBe(42);
    expect(decoded?.sampleRate).toBe(16000);
    expect(decoded?.channels).toBe(1);
    expect(decoded?.pcm.length).toBe(480);
  });

  it('preserves legacy Flash decodeWflvAudio byte compatibility', () => {
    const flashHeader = Buffer.alloc(24 + 480);
    flashHeader.writeUInt32LE(0x57464c56, 0); // legacy Flash magic
    flashHeader.writeUInt16LE(2, 4);
    flashHeader.writeUInt16LE(1, 6);
    flashHeader.writeUInt32LE(1, 8);
    flashHeader.writeUInt32LE(24000, 12);
    flashHeader.writeUInt32LE(1, 16);
    flashHeader.writeUInt32LE(0, 20);

    const decoded = decodeWflvAudio(flashHeader);
    expect(decoded).not.toBeNull();
    expect(decoded?.sampleRate).toBe(24000);
  });

  it('rejects byte-reversed VLFW magic in decodeVoiceV2Audio', () => {
    const header = Buffer.alloc(24);
    header[0] = 0x56; // 'V'
    header[1] = 0x4c; // 'L'
    header[2] = 0x46; // 'F'
    header[3] = 0x57; // 'W'
    header.writeUInt16LE(2, 4);
    expect(decodeVoiceV2Audio(header)).toBeNull();
  });

  it('handles Buffer[] RawData correctly', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    const startJson = JSON.stringify({
      type: 'voice.turn.start',
      request_id: 'req-buf-array',
      tier: 'std',
    });
    // Send as Buffer[] array of chunks
    const bufArray = [
      Buffer.from(startJson.slice(0, 10)),
      Buffer.from(startJson.slice(10)),
    ];
    ws.emit('message', bufArray, false);

    // Turn should be started; next START will be rejected with state_error
    ws.emit('message', Buffer.from(startJson), false);
    expect(ws.sent.some(s => s.includes('state_error'))).toBe(true);
  });

  it('rejects too-short PCM with derived duration error without forging duration', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-too-short',
          tier: 'std',
        })
      ),
      false
    );

    // Send only 1 chunk of 480 bytes (15ms < 1000ms minimum)
    const pcmChunk = Buffer.alloc(480);
    const frame0 = encodeVoiceV2Audio({
      pcm: pcmChunk,
      seq: 0,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      streaming: true,
    });
    ws.emit('message', frame0, true);

    const finalFrame = encodeVoiceV2Audio({
      pcm: Buffer.alloc(0),
      seq: 1,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      final: true,
    });
    await ws.emit('message', finalFrame, true);

    expect(
      ws.sent.some(s => s.includes('invalid_audio') && s.includes('too short'))
    ).toBe(true);
    expect(ws.sent.some(s => s.includes('event: turn.released'))).toBe(true);
  });

  it('allows second turn after a failed/aborted turn on the same connection', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    // 1. Start turn 1
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-abort-test',
          tier: 'std',
        })
      ),
      false
    );

    // Abort turn 1
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.abort',
          request_id: 'req-abort-test',
        })
      ),
      false
    );

    // 2. Start turn 2 (must succeed now that turn 1 was cleaned up)
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-turn-2-ok',
          tier: 'std',
        })
      ),
      false
    );

    // Send valid sequence for turn 2
    const pcmChunk = Buffer.alloc(480);
    const frame0 = encodeVoiceV2Audio({
      pcm: pcmChunk,
      seq: 0,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      streaming: true,
    });
    ws.emit('message', frame0, true);

    // Should NOT have received state_error or sequence_gap
    expect(ws.sent.some(s => s.includes('state_error'))).toBe(false);
    expect(ws.sent.some(s => s.includes('sequence_gap'))).toBe(false);
  });

  it('accumulates PCM and dispatches to Next.js on FINAL, emitting turn.released after completion', async () => {
    const ws = new MockDeviceWs();

    // Explicitly split Chinese character '你' (UTF-8 bytes: 0xE4, 0xBD, 0xA0) across chunks:
    // Chunk A: "...{\"delta\":\"" + 0xE4 + 0xBD
    // Chunk B: 0xA0 + "\"}\n\n"
    const chunkA = Buffer.concat([
      Buffer.from('event: text.delta\ndata: {"delta":"'),
      Buffer.from([0xe4, 0xbd]),
    ]);
    const chunkB = Buffer.concat([
      Buffer.from([0xa0]),
      Buffer.from('"}\n\n'),
      Buffer.from('event: turn.done\ndata: {}\n\n'),
    ]);

    let bodySent: Buffer | null = null;
    let headersSent: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      bodySent = options.body;
      headersSent = options.headers;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunkA);
          controller.enqueue(chunkB);
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

    // Send 70 chunks (70 * 480 = 33600 bytes = 1.05s >= 1000ms minimum)
    const pcmChunk = Buffer.alloc(480, 0x12);
    for (let seq = 0; seq < 70; seq++) {
      const frame = encodeVoiceV2Audio({
        pcm: pcmChunk,
        seq,
        sampleRate: STD_PRO_SAMPLE_RATE_HZ,
        streaming: true,
      });
      ws.emit('message', frame, true);
    }

    // Send FINAL frame
    const finalFrame = encodeVoiceV2Audio({
      pcm: Buffer.alloc(0),
      seq: 70,
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
    expect(headersSent['x-wqn-audio-duration-ms']).toBe('1050');

    expect(bodySent).not.toBeNull();
    expect((bodySent as unknown as Buffer).length).toBe(33600);

    // Check SSE stream received on device WS has properly reconstructed the split character '你' and emitted turn.released
    const textOutput = ws.sent.slice(1).join('');
    expect(textOutput).toContain('event: text.delta');
    expect(textOutput).toContain('"delta":"你"');
    expect(textOutput).toContain('event: turn.done');
    expect(textOutput).toContain('event: turn.released');
  });

  it('handles large START payload >128 bytes with conversation_id safely', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    const longReqId =
      'req-long-test-1234567890-abcdefghijklmnopqrstuvwxyz-1234567890';
    const longConvId =
      'conv-long-test-1234567890-abcdefghijklmnopqrstuvwxyz-1234567890';

    const largeStart = JSON.stringify({
      type: 'voice.turn.start',
      request_id: longReqId,
      tier: 'pro',
      conversation_id: longConvId,
      enable_thinking: true,
      reasoning_effort: 'high',
    });
    expect(largeStart.length).toBeGreaterThan(128);

    ws.emit('message', Buffer.from(largeStart), false);

    // Abort using the exact request_id
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.abort',
          request_id: longReqId,
        })
      ),
      false
    );

    // Now start a fresh turn - should succeed because previous turn was aborted
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-after-large',
          tier: 'std',
        })
      ),
      false
    );

    expect(ws.sent.some(s => s.includes('state_error'))).toBe(false);
  });

  it('guarantees turn.released is emitted even when backend returns HTTP error after FINAL', async () => {
    const ws = new MockDeviceWs();

    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({
          error: { code: 'upstream_failed', message: 'ASR failure' },
        }),
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
          request_id: 'req-err-release-test',
          tier: 'std',
        })
      ),
      false
    );

    // Send 70 chunks
    const pcmChunk = Buffer.alloc(480, 0x12);
    for (let seq = 0; seq < 70; seq++) {
      const frame = encodeVoiceV2Audio({
        pcm: pcmChunk,
        seq,
        sampleRate: STD_PRO_SAMPLE_RATE_HZ,
        streaming: true,
      });
      ws.emit('message', frame, true);
    }

    // Send FINAL frame
    const finalFrame = encodeVoiceV2Audio({
      pcm: Buffer.alloc(0),
      seq: 70,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      final: true,
    });
    await ws.emit('message', finalFrame, true);

    await new Promise(res => setTimeout(res, 50));

    const textOutput = ws.sent.slice(1).join('');
    // Must contain the SSE error AND the turn.released completion event
    expect(textOutput).toContain('event: error');
    expect(textOutput).toContain('upstream_failed');
    expect(textOutput).toContain('event: turn.released');

    // And now a second START MUST SUCCEED without state_error!
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-turn-after-err',
          tier: 'std',
        })
      ),
      false
    );

    expect(ws.sent.some(s => s.includes('state_error'))).toBe(false);
  });

  it('allows clean turn recovery after pre-FINAL abort while streaming PCM', async () => {
    const ws = new MockDeviceWs();
    await handleBatchVoiceConnection(
      ws as any,
      mockDevice,
      mockReq,
      mockConfig
    );

    // 1. Start turn
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-stream-abort',
          tier: 'std',
        })
      ),
      false
    );

    // Send 5 PCM chunks
    const pcmChunk = Buffer.alloc(480, 0x5a);
    for (let seq = 0; seq < 5; seq++) {
      const frame = encodeVoiceV2Audio({
        pcm: pcmChunk,
        seq,
        sampleRate: STD_PRO_SAMPLE_RATE_HZ,
        streaming: true,
      });
      ws.emit('message', frame, true);
    }

    // 2. Abort during streaming
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.abort',
          request_id: 'req-stream-abort',
        })
      ),
      false
    );

    // 3. Immediately start next turn
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'voice.turn.start',
          request_id: 'req-stream-next',
          tier: 'std',
        })
      ),
      false
    );

    // Send valid chunk 0 for new turn
    const newFrame = encodeVoiceV2Audio({
      pcm: pcmChunk,
      seq: 0,
      sampleRate: STD_PRO_SAMPLE_RATE_HZ,
      streaming: true,
    });
    ws.emit('message', newFrame, true);

    expect(ws.sent.some(s => s.includes('state_error'))).toBe(false);
    expect(ws.sent.some(s => s.includes('sequence_gap'))).toBe(false);
  });
});

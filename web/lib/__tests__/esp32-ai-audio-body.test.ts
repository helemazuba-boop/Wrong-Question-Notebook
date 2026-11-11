import { describe, expect, it, vi } from 'vitest';
import { readBoundedEsp32AudioBody } from '@/lib/esp32-ai-audio-body';
import { MAX_AUDIO_BODY_BYTES } from '@/lib/esp32-ai-audio-contract';

function request(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request('http://localhost/audio', {
    method: 'POST',
    body,
    signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('bounded PCM body reader', () => {
  it('preserves byte order and view offsets through buffer growth at the exact cap', async () => {
    const expected = Uint8Array.from(
      { length: MAX_AUDIO_BODY_BYTES },
      (_, i) => i % 251
    );
    let offset = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === expected.length) return controller.close();
          const end = Math.min(offset + 31789, expected.length);
          const padded = new Uint8Array(end - offset + 4);
          padded.set(expected.subarray(offset, end), 2);
          controller.enqueue(padded.subarray(2, padded.length - 2));
          offset = end;
        },
      },
      { highWaterMark: 0 }
    );
    const result = await readBoundedEsp32AudioBody(request(source));
    expect(Buffer.from(result).equals(Buffer.from(expected))).toBe(true);
    expect(result.byteLength).toBe(MAX_AUDIO_BODY_BYTES);
    expect(source.locked).toBe(false);
  });

  it('cancels a stalled upload on request abort without waiting for source cleanup', async () => {
    let entered!: () => void;
    const reading = new Promise<void>(resolve => {
      entered = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = new ReadableStream<Uint8Array>(
      {
        pull() {
          entered();
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const controller = new AbortController();
    const result = readBoundedEsp32AudioBody(
      request(source, controller.signal)
    );
    const rejected = expect(result).rejects.toMatchObject({
      code: 'invalid_audio',
      status: 400,
    });
    await reading;
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it('reports a read failure without returning partial PCM', async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (++pulls === 1) controller.enqueue(new Uint8Array(32000));
          else controller.error(new Error('fixture read failure'));
        },
      },
      { highWaterMark: 0 }
    );
    await expect(
      readBoundedEsp32AudioBody(request(source))
    ).rejects.toMatchObject({
      code: 'invalid_audio',
      status: 400,
    });
    expect(source.locked).toBe(false);
  });
});

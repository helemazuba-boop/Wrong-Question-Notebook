import { MAX_AUDIO_BODY_BYTES } from '@/lib/esp32-ai-audio-contract';
import {
  cancelVoiceReaderOnAbort,
  waitForVoiceOperation,
} from '@/lib/voice-operation';

export class Esp32AudioBodyError extends Error {
  constructor(
    public readonly code: 'too_large' | 'invalid_audio',
    public readonly status: 413 | 400
  ) {
    super(
      code === 'too_large'
        ? 'Audio body is too large'
        : 'Audio body could not be read'
    );
  }
}

/** Count actual bytes before retaining each chunk, independently of headers. */
export async function readBoundedEsp32AudioBody(
  req: Request
): Promise<ArrayBuffer> {
  if (!req.body) return new ArrayBuffer(0);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = req.body.getReader();
  } catch {
    throw new Esp32AudioBodyError('invalid_audio', 400);
  }
  const releaseReader = cancelVoiceReaderOnAbort(reader, req.signal);
  try {
    let bytes = new Uint8Array(Math.min(64 * 1024, MAX_AUDIO_BODY_BYTES));
    let size = 0;
    for (;;) {
      const { done, value } = await waitForVoiceOperation(
        reader.read(),
        req.signal
      );
      if (done) break;
      if (value.byteLength > MAX_AUDIO_BODY_BYTES - size) {
        throw new Esp32AudioBodyError('too_large', 413);
      }
      const needed = size + value.byteLength;
      if (needed > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(MAX_AUDIO_BODY_BYTES, Math.max(needed, bytes.byteLength * 2))
        );
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size = needed;
    }
    return bytes.slice(0, size).buffer;
  } catch (error) {
    // A slow or broken source cancellation must not delay the error response.
    void reader.cancel().catch(() => {});
    if (error instanceof Esp32AudioBodyError) throw error;
    throw new Esp32AudioBodyError('invalid_audio', 400);
  } finally {
    releaseReader();
  }
}

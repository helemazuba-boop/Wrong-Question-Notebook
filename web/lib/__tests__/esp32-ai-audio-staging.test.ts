import { describe, expect, it } from 'vitest';
import {
  analyzePcmS16le,
  pcmS16leToWavBuffer,
} from '@/lib/esp32-ai-audio-staging';

function exactArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

describe('ESP32 AI PCM diagnostics', () => {
  it('records bytes, duration, peak, RMS, and zero-sample ratio', () => {
    const pcm = Buffer.alloc(8);
    [0, -1000, 2000, 0].forEach((sample, index) => {
      pcm.writeInt16LE(sample, index * 2);
    });

    expect(analyzePcmS16le(exactArrayBuffer(pcm), 16000, 1)).toEqual({
      pcmBytes: 8,
      sampleCount: 4,
      sampleDurationMs: 0.25,
      peak: 2000,
      rms: 1118,
      zeroSampleRatio: 0.5,
    });
  });

  it('preserves the original PCM byte count in the WAV data chunk', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmS16leToWavBuffer(exactArrayBuffer(pcm), 16000, 1);

    expect(wav.byteLength).toBe(48);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});

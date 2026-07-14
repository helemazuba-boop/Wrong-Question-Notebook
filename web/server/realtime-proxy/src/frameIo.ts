/**
 * frameIo.ts — encode/decode for the WFLV binary frame protocol.
 *
 * Frame layout (24 B little-endian header + payload):
 *   [u32 magic      = 0x57464C56  ('WFLV')]
 *   [u16 version    = 2]
 *   [u16 flags      = 0x0001 stream | 0x0002 final]
 *   [u32 seq        = monotonic per session]
 *   [u32 sample_rate= 24000]
 *   [u32 channels   = 1]
 *   [u32 reserved   = 0]
 *   [audio bytes ...]
 *
 * Uplink  (device → proxy):  we decode these to extract raw PCM s16le
 *                           chunks, then forward to StepFun as
 *                           `input_audio_buffer.append` (base64-encoded).
 *
 * Downlink (proxy → device):  we receive base64 PCM/Opus from StepFun
 *                           (`response.audio.delta`), wrap each chunk in
 *                           a WFLV header, and ship as a binary frame.
 *
 * ESP32 side contract lives in
 *   firmware/wqn-zectrix-note4/main/flash_session.cpp:L42-L62
 * If you change a number here, change it there too.
 */

import {
  CHUNK_BYTES,
  CHUNK_FRAMES,
  DOWLINK_DEFAULT_SAMPLE_RATE_HZ,
  UPLINK_CHANNELS,
  UPLINK_SAMPLE_RATE_HZ,
  WFLV_AUDIO_MAGIC,
  WFLV_FLAG_FINAL,
  WFLV_FLAG_STREAM,
  WFLV_FRAME_VERSION,
  WFLV_HEADER_BYTES,
} from './types.ts';

/**
 * Decode a device-to-proxy WFLV audio frame. Returns the chunk payload
 * (raw PCM s16le) plus the parsed header. Returns null if the frame is
 * malformed — the caller treats null as a protocol violation and drops
 * the connection.
 */
export interface DecodedUplink {
  flags: number;
  seq: number;
  sampleRate: number;
  channels: number;
  pcm: Buffer;
}

export function decodeWflvAudio(buf: Buffer): DecodedUplink | null {
  if (buf.length < WFLV_HEADER_BYTES) return null;
  // little-endian reads match ESP32 packing (see flash_session.cpp)
  const magic = buf.readUInt32LE(0);
  if (magic !== WFLV_AUDIO_MAGIC) return null;
  const version = buf.readUInt16LE(4);
  if (version !== WFLV_FRAME_VERSION) return null;
  const flags = buf.readUInt16LE(6);
  const seq = buf.readUInt32LE(8);
  const sampleRate = buf.readUInt32LE(12);
  const channels = buf.readUInt32LE(16);
  // bytes 20..24 reserved
  return {
    flags,
    seq,
    sampleRate,
    channels,
    pcm: buf.subarray(WFLV_HEADER_BYTES),
  };
}

export function isLastChunk(flags: number): boolean {
  return (flags & WFLV_FLAG_FINAL) !== 0;
}

export function isStreaming(flags: number): boolean {
  return (flags & WFLV_FLAG_STREAM) !== 0;
}

/**
 * Encode a PCM/Opus chunk from StepFun into a WFLV binary frame for the
 * device. seq monotonic, sample rate negotiated at session.update time.
 */
export function encodeWflvAudio(params: {
  pcm: Buffer;
  seq: number;
  sampleRate?: number;
  channels?: number;
  final?: boolean;
  streaming?: boolean;
}): Buffer {
  const sampleRate = params.sampleRate ?? DOWLINK_DEFAULT_SAMPLE_RATE_HZ;
  const channels = params.channels ?? UPLINK_CHANNELS;
  let flags = 0;
  if (params.streaming !== false) flags |= WFLV_FLAG_STREAM;
  if (params.final) flags |= WFLV_FLAG_FINAL;

  const buf = Buffer.alloc(WFLV_HEADER_BYTES + params.pcm.length);
  buf.writeUInt32LE(WFLV_AUDIO_MAGIC, 0);
  buf.writeUInt16LE(WFLV_FRAME_VERSION, 4);
  buf.writeUInt16LE(flags, 6);
  buf.writeUInt32LE(params.seq >>> 0, 8);
  buf.writeUInt32LE(sampleRate, 12);
  buf.writeUInt32LE(channels, 16);
  buf.writeUInt32LE(0, 20); // reserved
  params.pcm.copy(buf, WFLV_HEADER_BYTES);
  return buf;
}

/**
 * Validate that the device's session.update JSON mentions the audio
 * formats we can actually forward. We accept anything that contains both
 * input_audio_format=pcm16 + input_sample_rate matching UPLINK_SAMPLE_RATE_HZ.
 * This is the only contract we strictly enforce — voice is checked at the
 * session.update message level (see voiceRelay.ts).
 */
export function expectedUplinkChunkBytes(): number {
  // 240 frames × 2 bytes = 480 bytes per 15 ms tick. StepFun expects
  // exactly this cadence so its VAD window aligns.
  return CHUNK_BYTES;
}

export function expectedUplinkSampleRate(): number {
  return UPLINK_SAMPLE_RATE_HZ;
}

/**
 * Linear-interpolation resample 16kHz -> 24kHz (ratio 2:3). Device captures at
 * 16kHz; StepFun Realtime expects 24kHz pcm16. Per-chunk (no cross-chunk state)
 * - introduces a sub-sample glitch at chunk boundaries, acceptable for speech.
 */
export function resample16to24(pcm: Buffer): Buffer {
  const inSamples = pcm.length / 2;
  if (inSamples === 0) return Buffer.alloc(0);
  const outSamples = Math.floor((inSamples * 3) / 2);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = (i * 2) / 3;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

/**
 * Linear-interpolation resample 24kHz -> 16kHz (ratio 3:2) with a minimal
 * anti-alias low-pass. StepFun sends 24kHz pcm16; device plays at 16kHz.
 * The previous version took every other output sample directly from the
 * source (no filtering), so 8-12kHz energy folded into 4-8kHz on decimation
 * -> broadband hiss that drowned speech. We now average two adjacent linear
 * interpolations (a 2-tap FIR) before emitting each sample; not a sharp
 * filter but enough to drop the foldover below the speech floor.
 */
export function resample24to16(pcm: Buffer): Buffer {
  const inSamples = pcm.length / 2;
  if (inSamples === 0) return Buffer.alloc(0);
  const outSamples = Math.floor((inSamples * 2) / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = (i * 3) / 2;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const i2 = Math.min(i0 + 2, inSamples - 1);
    const frac = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    const s2 = pcm.readInt16LE(i2 * 2);
    // 2-tap average of adjacent linear interpolations = simple low-pass.
    const a = s0 + (s1 - s0) * frac;
    const b = s1 + (s2 - s1) * frac;
    let v = Math.round((a + b) / 2);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

export { CHUNK_FRAMES };

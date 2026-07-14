// Standalone Node test for the WFLV header codec. Run with:
//   node tests/frame_io.test.cjs
// We copy the codec implementation here to avoid pulling Bun-specific
// types into a Node process.

const { Buffer } = require('node:buffer');

const WFLV_AUDIO_MAGIC = 0x57464c56;
const WFLV_FRAME_VERSION = 2;
const WFLV_FLAG_STREAM = 0x0001;
const WFLV_FLAG_FINAL = 0x0002;
const WFLV_HEADER_BYTES = 24;

function decodeWflvAudio(buf) {
  if (buf.length < WFLV_HEADER_BYTES) return null;
  const magic = buf.readUInt32LE(0);
  if (magic !== WFLV_AUDIO_MAGIC) return null;
  const version = buf.readUInt16LE(4);
  if (version !== WFLV_FRAME_VERSION) return null;
  const flags = buf.readUInt16LE(6);
  const seq = buf.readUInt32LE(8);
  const sampleRate = buf.readUInt32LE(12);
  const channels = buf.readUInt32LE(16);
  return {
    flags,
    seq,
    sampleRate,
    channels,
    pcm: buf.subarray(WFLV_HEADER_BYTES),
  };
}

function encodeWflvAudio({
  pcm,
  seq,
  sampleRate = 24000,
  channels = 1,
  final = false,
  streaming = true,
}) {
  let flags = 0;
  if (streaming !== false) flags |= WFLV_FLAG_STREAM;
  if (final) flags |= WFLV_FLAG_FINAL;
  const buf = Buffer.alloc(WFLV_HEADER_BYTES + pcm.length);
  buf.writeUInt32LE(WFLV_AUDIO_MAGIC, 0);
  buf.writeUInt16LE(WFLV_FRAME_VERSION, 4);
  buf.writeUInt16LE(flags, 6);
  buf.writeUInt32LE(seq >>> 0, 8);
  buf.writeUInt32LE(sampleRate, 12);
  buf.writeUInt32LE(channels, 16);
  buf.writeUInt32LE(0, 20);
  pcm.copy(buf, WFLV_HEADER_BYTES);
  return buf;
}

const pcm = Buffer.alloc(480, 0xab); // 240 frames × 2 B of synthetic PCM
const encoded = encodeWflvAudio({ pcm, seq: 42, sampleRate: 24000 });
const decoded = decodeWflvAudio(encoded);
const assert = require('node:assert/strict');

assert.equal(encoded.length, 504, '24B header + 480B PCM');
assert.equal(decoded.seq, 42);
assert.equal(decoded.sampleRate, 24000);
assert.equal(decoded.channels, 1);
assert.equal(
  decoded.flags & WFLV_FLAG_STREAM,
  WFLV_FLAG_STREAM,
  'stream flag set by default'
);
assert.equal(decoded.flags & WFLV_FLAG_FINAL, 0, 'final flag unset');
assert.deepEqual(decoded.pcm, pcm);

// final=true should set WFLV_FLAG_FINAL
const final = encodeWflvAudio({
  pcm,
  seq: 43,
  sampleRate: 24000,
  final: true,
  streaming: false,
});
const finalDecoded = decodeWflvAudio(final);
assert.equal(finalDecoded.flags & WFLV_FLAG_FINAL, WFLV_FLAG_FINAL);
assert.equal(finalDecoded.flags & WFLV_FLAG_STREAM, 0);

// Magic check: stray byte 0xff should reject.
const bad = Buffer.from([0xff, 0xff, 0xff, 0xff, ...encoded.subarray(4)]);
assert.equal(decodeWflvAudio(bad), null);

// Short buffer should reject.
assert.equal(decodeWflvAudio(encoded.subarray(0, 10)), null);

console.log('OK frame_io round-trip + edge cases');

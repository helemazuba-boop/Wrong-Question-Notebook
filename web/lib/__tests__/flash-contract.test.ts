import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  flashContractRoot,
  validateFlashControl,
} from '@/lib/test/flash-contract';
import { encodeWflvAudio } from '@/server/realtime-proxy/src/frameIo';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

describe('Flash relay/device contract', () => {
  it('matches the manifest binary layout and keeps legacy reserved zero', () => {
    const manifest = json(resolve(flashContractRoot, 'manifest.json'));
    const frame = encodeWflvAudio({ pcm: Buffer.alloc(2), seq: 1, epoch: 2 });
    expect(frame.length).toBe(manifest.binary.header_bytes + 2);
    expect(frame.readUInt32LE(0)).toBe(manifest.binary.magic_u32_le);
    expect(frame.readUInt16LE(4)).toBe(manifest.binary.version);
    expect(frame.readUInt32LE(12)).toBe(manifest.binary.sample_rate_hz);
    expect(frame.readUInt32LE(16)).toBe(manifest.binary.channels);
    expect(frame.readUInt32LE(20)).toBe(2);
    expect(
      encodeWflvAudio({
        pcm: Buffer.alloc(0),
        seq: 2,
        final: true,
      }).readUInt32LE(20)
    ).toBe(manifest.binary.uplink_reserved);
  });
  it('pins the schema and every golden fixture by content hash', () => {
    const manifest = json(resolve(flashContractRoot, 'manifest.json'));
    expect(sha256(resolve(flashContractRoot, manifest.schema))).toBe(
      manifest.schema_sha256
    );
    for (const [name, hash] of Object.entries(manifest.fixtures_sha256))
      expect(sha256(resolve(flashContractRoot, name))).toBe(hash);
  });
  it.each(readdirSync(resolve(flashContractRoot, 'fixtures/valid')))(
    'accepts %s',
    name => {
      expect(
        validateFlashControl(
          json(resolve(flashContractRoot, 'fixtures/valid', name))
        )
      ).toBe(true);
      expect(validateFlashControl.errors).toBeNull();
    }
  );
  it.each(readdirSync(resolve(flashContractRoot, 'fixtures/invalid')))(
    'rejects %s',
    name => {
      expect(
        validateFlashControl(
          json(resolve(flashContractRoot, 'fixtures/invalid', name))
        )
      ).toBe(false);
    }
  );
});

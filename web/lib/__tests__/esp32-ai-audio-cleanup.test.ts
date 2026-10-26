import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  access,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStagedEsp32AiAudioFile,
  stageEsp32AiAudioFile,
} from '../esp32-ai-audio-staging';

const clock = vi.hoisted(() => ({ ms: 0 }));
vi.mock('node:perf_hooks', () => ({
  performance: { now: () => clock.ms },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat),
  };
});

let directory: string;
beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
  vi.mocked(readdir).mockReset().mockImplementation(actual.readdir);
  vi.mocked(stat).mockReset().mockImplementation(actual.stat);
  clock.ms = 0;
  directory = await mkdtemp(join(tmpdir(), 'wqn-audio-cleanup-'));
  vi.stubEnv('WQN_ESP32_AI_AUDIO_TMP_DIR', directory);
  vi.stubEnv('WQN_ESP32_AI_AUDIO_URL_SECRET', 'ephemeral-cleanup-test-secret');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function stage() {
  return stageEsp32AiAudioFile({
    audio: new ArrayBuffer(32),
    sampleRate: 16000,
    channels: 1,
    publicBaseUrl: 'https://example.invalid',
    ttlMs: 60_000,
  });
}
async function expired(name: string) {
  const path = join(directory, name);
  await writeFile(path, 'old WAV');
  const old = new Date(Date.now() - 20 * 60_000);
  await utimes(path, old, old);
  return path;
}

describe('voice staging cleanup', () => {
  it('shares one sweep across ten uploads and bounds real metadata IO', async () => {
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      );
    const oldFiles = await Promise.all(
      Array.from({ length: 12 }, (_, index) => expired(`${index}.wav`))
    );
    const fresh = join(directory, 'fresh.wav');
    await writeFile(fresh, 'fresh WAV');
    await writeFile(join(directory, 'keep.txt'), 'not audio');
    let active = 0;
    let peak = 0;
    vi.mocked(stat).mockImplementation(async path => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await actual.stat(path);
      } finally {
        active--;
      }
    });
    const recordings = await Promise.all(Array.from({ length: 10 }, stage));
    console.info('AUDIO_CLEANUP_OPERATIONS', {
      uploads: recordings.length,
      scans: vi.mocked(readdir).mock.calls.length,
      metadataReads: vi.mocked(stat).mock.calls.length,
      metadataPeak: peak,
    });
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(13);
    expect(peak).toBeLessThanOrEqual(4);
    for (const path of oldFiles) await expect(access(path)).rejects.toThrow();
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(join(directory, 'keep.txt'))).resolves.toBeUndefined();
    for (const recording of recordings) {
      await expect(
        readStagedEsp32AiAudioFile(recording.id, new URL(recording.url))
      ).resolves.toHaveLength(76);
    }
  });

  it('runs again after the monotonic interval while URL expiry and explicit removal stay immediate', async () => {
    const recording = await stage();
    const oldFile = await expired('created-after-sweep.wav');
    clock.ms = 59_999;
    await stage();
    expect(readdir).toHaveBeenCalledTimes(1);
    await expect(access(oldFile)).resolves.toBeUndefined();
    const badUrl = new URL(recording.url);
    badUrl.searchParams.set('sig', '0'.repeat(64));
    await expect(
      readStagedEsp32AiAudioFile(recording.id, badUrl)
    ).rejects.toMatchObject({ code: 'invalid_signature' });
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(recording.expiresAtMs + 1);
    await expect(
      readStagedEsp32AiAudioFile(recording.id, new URL(recording.url))
    ).rejects.toMatchObject({ code: 'expired', status: 410 });
    now.mockRestore();
    await recording.cleanup();
    await expect(access(recording.filePath)).rejects.toThrow();
    clock.ms = 60_000;
    await stage();
    expect(readdir).toHaveBeenCalledTimes(2);
    await expect(access(oldFile)).rejects.toThrow();
  });

  it('retries a failed directory scan on the next upload', async () => {
    vi.mocked(readdir).mockRejectedValueOnce(new Error('temporary IO failure'));
    await stage();
    await stage();
    await stage();
    expect(readdir).toHaveBeenCalledTimes(2);
  });

  it('settles other file operations after one failure and retries the sweep', async () => {
    const paths = await Promise.all([
      expired('first.wav'),
      expired('second.wav'),
    ]);
    vi.mocked(stat).mockRejectedValueOnce(
      new Error('temporary metadata failure')
    );
    await stage();
    await stage();
    expect(readdir).toHaveBeenCalledTimes(2);
    for (const path of paths) await expect(access(path)).rejects.toThrow();
  });

  it('does not reuse a sweep from a different configured directory', async () => {
    await stage();
    const other = await mkdtemp(join(tmpdir(), 'wqn-audio-other-'));
    try {
      vi.stubEnv('WQN_ESP32_AI_AUDIO_TMP_DIR', other);
      await stage();
      expect(readdir).toHaveBeenCalledTimes(2);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

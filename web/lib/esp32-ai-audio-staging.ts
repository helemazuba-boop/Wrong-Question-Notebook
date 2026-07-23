import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger';

export type AudioStagingErrorCode =
  'disabled' | 'not_found' | 'invalid_signature' | 'expired';

export class AudioStagingError extends Error {
  constructor(
    public readonly code: AudioStagingErrorCode,
    message: string,
    public readonly status = 403
  ) {
    super(message);
    this.name = 'AudioStagingError';
  }
}

export interface StageEsp32AiAudioInput {
  audio: ArrayBuffer;
  sampleRate: number;
  channels: number;
  publicBaseUrl: string;
  ttlMs: number;
}

export interface StagedEsp32AiAudio {
  id: string;
  url: string;
  filePath: string;
  expiresAtMs: number;
  cleanup: () => Promise<void>;
}

export interface PcmS16leDiagnostics {
  pcmBytes: number;
  sampleCount: number;
  sampleDurationMs: number;
  peak: number;
  rms: number;
  zeroSampleRatio: number;
}

const DEFAULT_TMP_DIR = join(tmpdir(), 'wqn-esp32-ai-audio');
const AUDIO_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function getTmpDir(): string {
  return process.env.WQN_ESP32_AI_AUDIO_TMP_DIR || DEFAULT_TMP_DIR;
}

function getSigningSecret(): string {
  return (
    process.env.WQN_ESP32_AI_AUDIO_URL_SECRET ||
    process.env.DASHSCOPE_API_KEY ||
    ''
  ).trim();
}

function writeAscii(buffer: Buffer, offset: number, value: string) {
  buffer.write(value, offset, value.length, 'ascii');
}

export function analyzePcmS16le(
  audio: ArrayBuffer,
  sampleRate: number,
  channels: number
): PcmS16leDiagnostics {
  const pcm = Buffer.from(audio);
  const sampleCount = Math.floor(pcm.byteLength / 2);
  const frameCount = channels > 0 ? Math.floor(sampleCount / channels) : 0;
  let peak = 0;
  let sumSquares = 0;
  let zeroSamples = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = pcm.readInt16LE(index * 2);
    const absolute = Math.abs(sample);
    if (absolute > peak) peak = absolute;
    if (sample === 0) zeroSamples += 1;
    sumSquares += sample * sample;
  }

  return {
    pcmBytes: pcm.byteLength,
    sampleCount,
    sampleDurationMs:
      sampleRate > 0
        ? Math.round((frameCount / sampleRate) * 1_000_000) / 1_000
        : 0,
    peak,
    rms: sampleCount > 0 ? Math.round(Math.sqrt(sumSquares / sampleCount)) : 0,
    zeroSampleRatio:
      sampleCount > 0
        ? Math.round((zeroSamples / sampleCount) * 1_000_000) / 1_000_000
        : 0,
  };
}

export function pcmS16leToWavBuffer(
  audio: ArrayBuffer,
  sampleRate: number,
  channels: number
): Buffer {
  const pcm = Buffer.from(audio);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  writeAscii(header, 0, 'RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  writeAscii(header, 8, 'WAVE');
  writeAscii(header, 12, 'fmt ');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  writeAscii(header, 36, 'data');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function signAudioUrl(id: string, expiresAtMs: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${id}.${expiresAtMs}`)
    .digest('hex');
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) {
    return false;
  }

  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getAudioPath(id: string): string {
  return join(getTmpDir(), `${id}.wav`);
}

async function cleanupExpiredAudioFiles(nowMs = Date.now()) {
  const dir = getTmpDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  await Promise.allSettled(
    entries
      .filter(entry => entry.endsWith('.wav'))
      .map(async entry => {
        const filePath = join(dir, entry);
        const fileStat = await stat(filePath);
        if (nowMs - fileStat.mtimeMs > 15 * 60 * 1000) {
          await rm(filePath, { force: true });
        }
      })
  );
}

export async function stageEsp32AiAudioFile(
  input: StageEsp32AiAudioInput
): Promise<StagedEsp32AiAudio> {
  const publicBaseUrl = input.publicBaseUrl.replace(/\/+$/, '');
  if (!publicBaseUrl) {
    throw new AudioStagingError(
      'disabled',
      'ESP32 AI public base URL is not configured',
      503
    );
  }

  const secret = getSigningSecret();
  if (!secret) {
    throw new AudioStagingError(
      'disabled',
      'ESP32 AI audio URL signing secret is not configured',
      503
    );
  }

  const id = randomUUID();
  const expiresAtMs = Date.now() + input.ttlMs;
  const filePath = getAudioPath(id);
  const wav = pcmS16leToWavBuffer(
    input.audio,
    input.sampleRate,
    input.channels
  );

  await mkdir(getTmpDir(), { recursive: true });
  await cleanupExpiredAudioFiles();
  await writeFile(filePath, wav, { flag: 'wx' });

  const diagnostics = analyzePcmS16le(
    input.audio,
    input.sampleRate,
    input.channels
  );
  logger.info('ESP32 AI temporary WAV staged', {
    component: 'Esp32AiAudioStaging',
    audioId: id,
    wavBytes: wav.byteLength,
    pcmBytes: diagnostics.pcmBytes,
    sampleDurationMs: diagnostics.sampleDurationMs,
    expiresAtMs,
  });

  const url = new URL(`/api/esp32/ai/audio-temp/${id}`, publicBaseUrl);
  url.searchParams.set('expires', String(expiresAtMs));
  url.searchParams.set('sig', signAudioUrl(id, expiresAtMs, secret));

  return {
    id,
    url: url.toString(),
    filePath,
    expiresAtMs,
    cleanup: () => rm(filePath, { force: true }),
  };
}

export async function readStagedEsp32AiAudioFile(
  id: string,
  requestUrl: URL
): Promise<Buffer> {
  if (!AUDIO_ID_RE.test(id)) {
    throw new AudioStagingError('not_found', 'Audio file not found', 404);
  }

  const expires = Number(requestUrl.searchParams.get('expires'));
  const sig = requestUrl.searchParams.get('sig') || '';
  if (!Number.isSafeInteger(expires)) {
    throw new AudioStagingError(
      'invalid_signature',
      'Invalid audio URL signature',
      403
    );
  }

  if (Date.now() > expires) {
    throw new AudioStagingError('expired', 'Audio URL expired', 410);
  }

  const secret = getSigningSecret();
  if (!secret) {
    throw new AudioStagingError(
      'disabled',
      'ESP32 AI audio URL signing secret is not configured',
      503
    );
  }

  const expectedSig = signAudioUrl(id, expires, secret);
  if (!constantTimeEqualHex(sig, expectedSig)) {
    throw new AudioStagingError(
      'invalid_signature',
      'Invalid audio URL signature',
      403
    );
  }

  try {
    return await readFile(getAudioPath(id));
  } catch {
    throw new AudioStagingError('not_found', 'Audio file not found', 404);
  }
}

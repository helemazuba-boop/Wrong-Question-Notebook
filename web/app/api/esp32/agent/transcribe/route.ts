import { NextRequest, NextResponse } from 'next/server';

import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_FORMAT,
  AUDIO_SAMPLE_RATE,
  MAX_AUDIO_BODY_BYTES,
  MAX_AUDIO_DURATION_MS,
  MIN_AUDIO_DURATION_MS,
  MIN_PCM_AUDIO_BODY_BYTES,
} from '@/lib/esp32-ai-audio-contract';
import {
  Esp32AiProviderError,
  runEsp32VoiceTranscription,
} from '@/lib/esp32-ai-provider';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';

export const runtime = 'nodejs';

function errorResponse(
  code: string,
  message: string,
  status: number
): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status }
  );
}

function validateAudioHeaders(req: Request): NextResponse | null {
  const contentType =
    req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  if (contentType !== 'application/octet-stream') {
    return errorResponse(
      'invalid_audio',
      'Unsupported audio content type',
      415
    );
  }
  if (
    req.headers.get('x-wqn-audio-sample-rate') !== AUDIO_SAMPLE_RATE ||
    req.headers.get('x-wqn-audio-sample-format') !== AUDIO_SAMPLE_FORMAT ||
    req.headers.get('x-wqn-audio-channels') !== AUDIO_CHANNELS
  ) {
    return errorResponse('invalid_audio', 'Unsupported audio format', 415);
  }
  const durationMs = Number(req.headers.get('x-wqn-audio-duration-ms'));
  if (
    !Number.isInteger(durationMs) ||
    durationMs < MIN_AUDIO_DURATION_MS ||
    durationMs > MAX_AUDIO_DURATION_MS
  ) {
    return errorResponse('invalid_audio', 'Invalid audio duration', 422);
  }
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BODY_BYTES) {
    return errorResponse('too_large', 'Audio body is too large', 413);
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof NextResponse) return auth;
  const headerError = validateAudioHeaders(req);
  if (headerError) return headerError;

  const audio = await req.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BODY_BYTES) {
    return errorResponse('too_large', 'Audio body is too large', 413);
  }
  if (audio.byteLength < MIN_PCM_AUDIO_BODY_BYTES) {
    return errorResponse('invalid_audio', 'Audio body is too short', 422);
  }
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.WQN_ESP32_AGENT_TRANSCRIBE_MOCK === '1'
  ) {
    return NextResponse.json({
      success: true,
      data: { transcript: 'mock agent transcript', latency_ms: 0 },
    });
  }

  try {
    const result = await runEsp32VoiceTranscription({
      audio,
      sampleRate: Number(AUDIO_SAMPLE_RATE),
      channels: Number(AUDIO_CHANNELS),
      sampleFormat: 's16le',
      userId: auth.userId,
      deviceId: auth.deviceId,
    });
    return NextResponse.json({
      success: true,
      data: {
        transcript: result.transcript,
        latency_ms: result.latencyMs,
        asr: result.asr,
      },
    });
  } catch (error) {
    if (error instanceof Esp32AiProviderError) {
      return errorResponse(error.code, error.message, error.status);
    }
    return errorResponse('asr_failed', 'Voice transcription failed', 500);
  }
}

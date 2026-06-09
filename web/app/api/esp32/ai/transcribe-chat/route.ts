import { NextRequest, NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import {
  Esp32AiProviderError,
  isEsp32AiProviderConfigured,
  runEsp32AiProvider,
} from '@/lib/esp32-ai-provider';
import { createRateLimit } from '@/lib/rate-limit';
import { withSecurity } from '@/lib/security-middleware';

export const runtime = 'nodejs';

export const AUDIO_SAMPLE_RATE = '16000';
export const AUDIO_SAMPLE_FORMAT = 's16le';
export const AUDIO_CHANNELS = '1';
export const MIN_AUDIO_DURATION_MS = 300;
export const MAX_AUDIO_DURATION_MS = 20000;
export const MAX_PCM_AUDIO_BODY_BYTES =
  (Number(AUDIO_SAMPLE_RATE) * 2 * MAX_AUDIO_DURATION_MS) / 1000;
export const AUDIO_BODY_TOLERANCE_BYTES = 4096;
export const MAX_AUDIO_BODY_BYTES =
  MAX_PCM_AUDIO_BODY_BYTES + AUDIO_BODY_TOLERANCE_BYTES;

const AUTH_RATE_LIMIT = createRateLimit({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyGenerator: req => `esp32-ai-auth:${getClientIp(req)}`,
});

const DEVICE_RATE_LIMIT = createRateLimit({
  windowMs: 60 * 1000,
  maxRequests: 12,
  keyGenerator: req =>
    `esp32-ai-device:${req.headers.get('x-wqn-authenticated-device-id') ?? getClientIp(req)}`,
});

type Esp32AiErrorCode =
  | 'unauthorized'
  | 'too_large'
  | 'invalid_audio'
  | 'no_speech'
  | 'asr_failed'
  | 'model_failed'
  | 'rate_limited'
  | 'disabled'
  | 'notebook_permission_denied'
  | 'todo_failed'
  | 'word_failed';

function getClientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function createEsp32AiErrorResponse(
  code: Esp32AiErrorCode,
  message: string,
  status: number,
  init?: ResponseInit
): NextResponse {
  const response = NextResponse.json(
    {
      success: false,
      error: { code, message },
    },
    { status, headers: init?.headers }
  );

  return response;
}

function cloneHeadersWithDeviceId(
  req: NextRequest,
  deviceId: string
): NextRequest {
  const headers = new Headers(req.headers);
  headers.set('x-wqn-authenticated-device-id', deviceId);

  return new NextRequest(req.url, {
    method: req.method,
    headers,
  });
}

function getContentType(req: Request): string {
  return (
    req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  );
}

function validateRequiredAudioHeaders(req: Request): NextResponse | null {
  if (getContentType(req) !== 'application/octet-stream') {
    return createEsp32AiErrorResponse(
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
    return createEsp32AiErrorResponse(
      'invalid_audio',
      'Unsupported audio format',
      415
    );
  }

  const durationHeader = req.headers.get('x-wqn-audio-duration-ms');
  const durationMs = durationHeader ? Number(durationHeader) : NaN;
  if (
    !Number.isInteger(durationMs) ||
    durationMs < MIN_AUDIO_DURATION_MS ||
    durationMs > MAX_AUDIO_DURATION_MS
  ) {
    return createEsp32AiErrorResponse(
      'invalid_audio',
      'Invalid audio duration',
      422
    );
  }

  return null;
}

function getContentLength(req: Request): number | null {
  const contentLength = req.headers.get('content-length');
  if (!contentLength) return null;

  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createTooLargeResponse(): NextResponse {
  return createEsp32AiErrorResponse(
    'too_large',
    `Audio body exceeds ${MAX_AUDIO_BODY_BYTES} bytes`,
    413
  );
}

function isMockEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.WQN_ESP32_AI_TRANSCRIBE_CHAT_MOCK === '1'
  );
}

function isVoiceAiConfigured(): boolean {
  return isEsp32AiProviderConfigured();
}

async function transcribeChat(req: NextRequest) {
  const authRateLimitResponse = AUTH_RATE_LIMIT(req);
  if (authRateLimitResponse) {
    return createEsp32AiErrorResponse(
      'rate_limited',
      'Rate limit exceeded',
      429,
      { headers: authRateLimitResponse.headers }
    );
  }

  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const deviceRateLimitResponse = DEVICE_RATE_LIMIT(
    cloneHeadersWithDeviceId(req, authResult.deviceId)
  );
  if (deviceRateLimitResponse) {
    return createEsp32AiErrorResponse(
      'rate_limited',
      'Rate limit exceeded',
      429,
      { headers: deviceRateLimitResponse.headers }
    );
  }

  const headerError = validateRequiredAudioHeaders(req);
  if (headerError) return headerError;

  const contentLength = getContentLength(req);
  if (contentLength !== null && contentLength > MAX_AUDIO_BODY_BYTES) {
    return createTooLargeResponse();
  }

  const audio = await req.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BODY_BYTES) {
    return createTooLargeResponse();
  }

  if (isMockEnabled()) {
    return NextResponse.json({
      success: true,
      data: {
        transcript: 'mock transcript',
        reply_text: 'mock reply',
        conversation_id: req.headers.get('x-wqn-conversation-id') ?? null,
        latency_ms: 0,
        status_trace: [
          { stage: 'request', status: 'succeeded', elapsed_ms: 0 },
        ],
        asr: {
          provider: 'mock',
          model: 'mock',
          status: 'succeeded',
          text: 'mock transcript',
          request_id: null,
          elapsed_ms: 0,
        },
        function_calls: [],
        actions: [],
      },
    });
  }

  if (!isVoiceAiConfigured()) {
    return createEsp32AiErrorResponse(
      'disabled',
      'ESP32 AI voice route is disabled',
      503
    );
  }

  try {
    const result = await runEsp32AiProvider({
      audio,
      sampleRate: Number(AUDIO_SAMPLE_RATE),
      channels: Number(AUDIO_CHANNELS),
      sampleFormat: AUDIO_SAMPLE_FORMAT,
      conversationId: req.headers.get('x-wqn-conversation-id'),
      userId: authResult.userId,
      deviceId: authResult.deviceId,
    });

    return NextResponse.json({
      success: true,
      data: {
        transcript: result.transcript,
        reply_text: result.replyText,
        conversation_id: result.conversationId,
        latency_ms: result.latencyMs,
        actions: result.actions,
        status_trace: result.statusTrace,
        asr: result.asr,
        function_calls: result.functionCalls,
      },
    });
  } catch (error) {
    if (error instanceof Esp32AiProviderError) {
      return createEsp32AiErrorResponse(
        error.code,
        error.message,
        error.status
      );
    }
    return createEsp32AiErrorResponse(
      'model_failed',
      'ESP32 AI provider failed',
      500
    );
  }
}

export const POST = withSecurity(transcribeChat, {
  // Route-local AUTH_RATE_LIMIT and DEVICE_RATE_LIMIT keep 429 responses
  // on the ESP32 contract shape instead of the generic middleware body.
  enableRateLimit: false,
  enableRequestValidation: true,
});

import { NextRequest, NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import {
  Esp32AiProviderError,
  isEsp32AiProviderConfigured,
  runEsp32AiProvider,
} from '@/lib/esp32-ai-provider';
import { createRateLimit } from '@/lib/rate-limit';
import { withSecurity } from '@/lib/security-middleware';
import { analyzePcmS16le } from '@/lib/esp32-ai-audio-staging';
import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_FORMAT,
  AUDIO_SAMPLE_RATE,
  MAX_AUDIO_BODY_BYTES,
  MAX_AUDIO_DURATION_MS,
  MIN_AUDIO_DURATION_MS,
  MIN_PCM_AUDIO_BODY_BYTES,
} from '@/lib/esp32-ai-audio-contract';
import { logger } from '@/lib/logger';
import { handleV2Streaming, isV2StreamingRequest } from './v2-handler';

export const runtime = 'nodejs';

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
  | 'asr_timeout'
  | 'model_failed'
  | 'chat_timeout'
  | 'provider_unavailable'
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

function validateV2ControlHeaders(req: Request): NextResponse | null {
  const tier = req.headers.get('x-wqn-ai-tier');
  if (tier !== null && tier !== 'std' && tier !== 'pro') {
    return createEsp32AiErrorResponse('invalid_audio', 'Invalid AI tier', 422);
  }

  const enableThinking = req.headers.get('x-wqn-enable-thinking');
  if (
    enableThinking !== null &&
    enableThinking !== 'true' &&
    enableThinking !== 'false'
  ) {
    return createEsp32AiErrorResponse(
      'invalid_audio',
      'Invalid thinking mode',
      422
    );
  }

  const reasoningEffort = req.headers.get('x-wqn-reasoning-effort');
  if (
    reasoningEffort !== null &&
    reasoningEffort !== 'low' &&
    reasoningEffort !== 'medium' &&
    reasoningEffort !== 'high'
  ) {
    return createEsp32AiErrorResponse(
      'invalid_audio',
      'Invalid reasoning effort',
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

function createTooShortResponse(): NextResponse {
  return createEsp32AiErrorResponse(
    'invalid_audio',
    `Audio body contains less than ${MIN_AUDIO_DURATION_MS} ms of PCM samples`,
    422
  );
}

function logPcmDiagnostics(input: {
  req: NextRequest;
  audio: ArrayBuffer;
  deviceId: string;
  protocol: 'v1' | 'v2-streaming';
}): void {
  const diagnostics = analyzePcmS16le(
    input.audio,
    Number(AUDIO_SAMPLE_RATE),
    Number(AUDIO_CHANNELS)
  );
  logger.info('ESP32 AI raw PCM received', {
    component: 'Esp32AiTranscribeChat',
    protocol: input.protocol,
    deviceId: input.deviceId,
    tier: input.req.headers.get('x-wqn-ai-tier') || 'std',
    declaredDurationMs: Number(
      input.req.headers.get('x-wqn-audio-duration-ms') || 0
    ),
    pcmBytes: diagnostics.pcmBytes,
    sampleCount: diagnostics.sampleCount,
    sampleDurationMs: diagnostics.sampleDurationMs,
    peak: diagnostics.peak,
    rms: diagnostics.rms,
    zeroSampleRatio: diagnostics.zeroSampleRatio,
  });
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

function isAuthorizedInternalProxy(req: NextRequest): boolean {
  const internalProxyAuth = req.headers.get(
    'x-wqn-internal-proxy-authorization'
  );
  const expectedSecret = process.env.WQN_REALTIME_PROXY_SECRET;
  return Boolean(
    expectedSecret &&
    expectedSecret.length >= 32 &&
    internalProxyAuth === `Bearer ${expectedSecret}`
  );
}

async function transcribeChat(req: NextRequest): Promise<NextResponse> {
  const isInternal = isAuthorizedInternalProxy(req);
  if (!isInternal) {
    const authRateLimitResponse = AUTH_RATE_LIMIT(req);
    if (authRateLimitResponse) {
      return createEsp32AiErrorResponse(
        'rate_limited',
        'Rate limit exceeded',
        429,
        { headers: authRateLimitResponse.headers }
      );
    }
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
  logPcmDiagnostics({
    req,
    audio,
    deviceId: authResult.deviceId,
    protocol: 'v1',
  });
  if (audio.byteLength < MIN_PCM_AUDIO_BODY_BYTES) {
    return createTooShortResponse();
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
      tier: req.headers.get('x-wqn-ai-tier'),
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

async function transcribeChatV2(req: NextRequest): Promise<NextResponse> {
  const isInternal = isAuthorizedInternalProxy(req);
  if (!isInternal) {
    const authRateLimitResponse = AUTH_RATE_LIMIT(req);
    if (authRateLimitResponse) {
      return createEsp32AiErrorResponse(
        'rate_limited',
        'Rate limit exceeded',
        429,
        { headers: authRateLimitResponse.headers }
      );
    }
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

  const headerError =
    validateRequiredAudioHeaders(req) ?? validateV2ControlHeaders(req);
  if (headerError) return headerError;

  const contentLength = getContentLength(req);
  if (contentLength !== null && contentLength > MAX_AUDIO_BODY_BYTES) {
    return createTooLargeResponse();
  }

  if (!isVoiceAiConfigured()) {
    return createEsp32AiErrorResponse(
      'disabled',
      'ESP32 AI voice route is disabled',
      503
    );
  }

  const audio = await req.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BODY_BYTES) {
    return createTooLargeResponse();
  }
  logPcmDiagnostics({
    req,
    audio,
    deviceId: authResult.deviceId,
    protocol: 'v2-streaming',
  });
  if (audio.byteLength < MIN_PCM_AUDIO_BODY_BYTES) {
    return createTooShortResponse();
  }

  return handleV2Streaming(req, undefined, { authResult, audio });
}

async function dispatch(req: NextRequest): Promise<NextResponse> {
  if (isV2StreamingRequest(req)) {
    return transcribeChatV2(req);
  }
  return transcribeChat(req);
}

export const POST = withSecurity(dispatch, {
  // Route-local AUTH_RATE_LIMIT and DEVICE_RATE_LIMIT keep 429 responses
  // on the ESP32 contract shape instead of the generic middleware body.
  enableRateLimit: false,
  enableRequestValidation: true,
});

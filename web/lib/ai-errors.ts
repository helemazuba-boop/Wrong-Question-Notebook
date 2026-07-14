// ai-errors.ts — Centralised ESP32 AI error codes.
//
// Spec reference: wqn-cloud-relay/docs/03-common-error-codes.md and
// wqn-cloud-relay/docs/04-std-pro-streaming-protocol.md §4.5.
//
// The error_code strings are part of the on-the-wire contract — do not
// rename without updating the firmware's error parser (main/ui/page_ai.cpp
// and main/wqn_api.h::WqnAiErrorCode).

export type Esp32AiErrorCode =
  // ---- Part A (HTTP+SSE std/pro) ----
  | 'unauthorized'
  | 'forbidden'
  | 'too_large'
  | 'invalid_audio'
  | 'no_speech'
  | 'asr_failed'
  | 'asr_timeout'
  | 'model_failed'
  | 'chat_timeout'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'notebook_permission_denied'
  | 'todo_failed'
  | 'word_failed'
  | 'disabled'
  | 'bad_request'
  // ---- Part B (Flash Realtime v2) — listed here for one source of truth,
  // emitted by the realtime-proxy service, not by this server. Kept in the
  // union so shared error-handling helpers can take the superset.
  | 'tts_failed'
  | 'tts_timeout'
  | 'ws_proxy_error'
  | 'internal';

export interface Esp32AiErrorPayload {
  error_code: Esp32AiErrorCode;
  stage?: string;
  message?: string;
  latency_ms?: number;
  /** Optional debug-only context. The firmware logs this; the EPD does not. */
  details?: Record<string, unknown>;
}

const HTTP_STATUS: Record<Esp32AiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  too_large: 413,
  invalid_audio: 415,
  no_speech: 422,
  asr_failed: 500,
  asr_timeout: 504,
  model_failed: 500,
  chat_timeout: 504,
  provider_unavailable: 502,
  rate_limited: 429,
  notebook_permission_denied: 403,
  todo_failed: 500,
  word_failed: 500,
  disabled: 503,
  bad_request: 400,
  tts_failed: 500,
  tts_timeout: 504,
  ws_proxy_error: 502,
  internal: 500,
};

export function httpStatusFor(code: Esp32AiErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

/**
 * Terminal SSE event: the server emits `event: error` with this payload as
 * the last frame, then closes the connection. The firmware's SSE parser
 * stops reading on receipt and surfaces the code.
 */
// SseErrorFrame carries no fields beyond the standard error payload.
export type SseErrorFrame = Esp32AiErrorPayload;

import type { SseWriter } from './ai-stream';

export async function closeSseWithError(
  writer: SseWriter,
  code: Esp32AiErrorCode,
  message: string,
  context: {
    stage?: string;
    latency_ms?: number;
    details?: Record<string, unknown>;
  } = {}
): Promise<void> {
  if (writer.isClosed()) return;
  const payload: SseErrorFrame = {
    error_code: code,
    ...(context.stage ? { stage: context.stage } : {}),
    message,
    latency_ms: context.latency_ms ?? 0,
    ...(context.details ? { details: context.details } : {}),
  };
  writer.emit('error', payload);
  writer.close();
}

/**
 * Convert a thrown value into an (error_code, message, status) triple. Used
 * by the v1 route's catch block as well so the v1 contract stays identical.
 */
export function classifyAiError(
  error: unknown,
  fallback: Esp32AiErrorCode = 'model_failed'
): {
  code: Esp32AiErrorCode;
  message: string;
  status: number;
} {
  // Esp32AiProviderError carries its own code/status.
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    'status' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    const code = (error as { code: string }).code as Esp32AiErrorCode;
    const status = (error as { status: number }).status;
    return {
      code,
      message: error instanceof Error ? error.message : String(error),
      status,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: fallback,
    message: message || 'ESP32 AI provider failed',
    status: httpStatusFor(fallback),
  };
}

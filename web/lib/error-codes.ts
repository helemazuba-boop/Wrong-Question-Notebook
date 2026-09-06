import { isApiError } from './api-client';

/**
 * Shared convention for turning thrown request errors into user-facing
 * text: known backend error codes map to a localized message, everything
 * else falls back to the server's message, then to a generic localized
 * fallback.
 *
 * Each caller owns its code→key table because i18n keys live in the
 * caller's message namespace. See problem-ingestion-workspace.tsx for the
 * fullest example; the workspace's local copy migrates here when that
 * chain is refactored.
 */
export type ErrorTranslator = (key: string) => string;

export function apiErrorCode(error: unknown): string | null {
  return isApiError(error) ? error.code : null;
}

export function localizedApiErrorMessage(
  error: unknown,
  errorKeys: Record<string, string>,
  t: ErrorTranslator,
  fallback: string
): string {
  const code = apiErrorCode(error);
  if (code) {
    const key = errorKeys[code];
    if (key) return t(key);
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * The single browser-side fetch wrapper.
 *
 * Components must not call `fetch()` directly; every browser-to-API request
 * goes through here so that envelope unwrapping, error normalization, and
 * JSON handling have exactly one implementation. Server-side code (route
 * handlers, server components) and lib/ internals keep using their own
 * transports.
 *
 * Two response shapes exist in the codebase. New routes use the
 * `createApiSuccessResponse` / `createApiErrorResponse` envelope:
 *   { success: true, data: T } | { error: string, status: number }
 * Older routes return raw JSON bodies. apiFetch unwraps the envelope when
 * present and passes raw bodies through, so both stay supported until the
 * legacy routes are migrated.
 */

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable error code from the server payload, when present. */
  readonly code: string | null;
  readonly details: unknown;

  constructor(
    message: string,
    status: number,
    options: { code?: string | null; details?: unknown } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options.code ?? null;
    this.details = options.details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Human-facing message for any thrown value, without leaking internals. */
export function errorMessage(error: unknown, fallback = 'Request failed') {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

type EnvelopeError = {
  error: string;
  status?: number;
  code?: string;
  details?: unknown;
};

type EnvelopeSuccess<T> = {
  success: true;
  data: T;
  message?: string;
};

async function parseResponse<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body (204, redirects, text errors). Handled below by status.
  }

  if (!response.ok) {
    const payload = (body ?? {}) as Partial<EnvelopeError>;
    throw new ApiError(
      payload.error || `Request failed with status ${response.status}`,
      response.status,
      {
        code: resolveErrorCode(payload),
        details: payload.details,
      }
    );
  }

  if (body && typeof body === 'object') {
    const candidate = body as Partial<EnvelopeSuccess<T>> &
      Partial<EnvelopeError>;
    if (candidate.success === true && 'data' in candidate) {
      return candidate.data as T;
    }
    if (typeof candidate.error === 'string') {
      // Malformed 2xx envelope: treat as an error even though the status is OK.
      throw new ApiError(candidate.error, response.status, {
        code: resolveErrorCode(candidate),
        details: candidate.details,
      });
    }
  }

  return body as T;
}

/**
 * Backend routes attach a machine-readable code in two places: top-level
 * `code`, or inside `details` (`details.code`, the createApiErrorResponse
 * convention used by the ingestion workspace). Both resolve here.
 */
function resolveErrorCode(payload: Partial<EnvelopeError>): string | null {
  if (typeof payload.code === 'string') return payload.code;
  const details = payload.details;
  if (
    details &&
    typeof details === 'object' &&
    'code' in details &&
    typeof (details as { code: unknown }).code === 'string'
  ) {
    return (details as { code: string }).code;
  }
  return null;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    // Network failure / abort / DNS. Distinguish aborts so callers can ignore
    // cancelled queries instead of showing spurious error toasts.
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new ApiError('Network error', 0);
  }
  return parseResponse<T>(response);
}

export function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: 'GET' });
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPatch<T>(
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    method: 'PATCH',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPut<T>(
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: 'DELETE' });
}

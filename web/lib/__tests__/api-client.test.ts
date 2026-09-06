import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  errorMessage,
  isApiError,
} from '../api-client';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps the success envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { tokens: [1, 2] }, timestamp: 'x' })
    );
    await expect(apiGet<{ tokens: number[] }>('/api/x')).resolves.toEqual({
      tokens: [1, 2],
    });
  });

  it('passes raw JSON bodies through for legacy routes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'a' }]));
    await expect(apiGet('/api/legacy')).resolves.toEqual([{ id: 'a' }]);
  });

  it('throws ApiError with server message and status on error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'At most 5 active tokens are allowed', status: 403 },
        403
      )
    );
    const err = await apiGet('/api/x').catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect((err as ApiError).message).toBe(
      'At most 5 active tokens are allowed'
    );
    expect((err as ApiError).status).toBe(403);
  });

  it('falls back to a status message on non-JSON error bodies', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('gateway timeout', { status: 504 })
    );
    const err = await apiGet('/api/x').catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(504);
    expect((err as ApiError).message).toContain('504');
  });

  it('treats a malformed 2xx error envelope as an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 200));
    const err = await apiGet('/api/x').catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect((err as ApiError).message).toBe('boom');
  });

  it('maps network failures to ApiError status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const err = await apiGet('/api/x').catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toBe('Network error');
  });

  it('rethrows aborts as-is so callers can ignore cancelled queries', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValueOnce(abortError);
    await expect(apiGet('/api/x')).rejects.toBe(abortError);
  });

  it('serializes JSON bodies and sets Content-Type on POST', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: 'ok' })
    );
    await apiPost('/api/x', { name: 'n' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'n' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
  });

  it('sends DELETE without a Content-Type header', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: null })
    );
    await apiDelete('/api/x/1');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({});
  });

  it('errorMessage prefers ApiError message and falls back cleanly', () => {
    expect(errorMessage(new ApiError('server said no', 400))).toBe(
      'server said no'
    );
    expect(errorMessage(new TypeError('oops'))).toBe('oops');
    expect(errorMessage('junk', 'fallback')).toBe('fallback');
  });
});

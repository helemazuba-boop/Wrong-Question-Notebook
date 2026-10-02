import { describe, expect, it, vi } from 'vitest';

import {
  checkLimitedAccess,
  getProblemSetBasic,
} from '@/lib/problem-set-utils';
import {
  isRetryableAuthError,
  retryOnAuthFailure,
  toAuthUnavailableError,
} from '@/lib/supabase-utils';

/**
 * Session-token rejections must never collapse into the "not found" /
 * "not shared with you" results these functions return, because page-level
 * loaders memoise those with `unstable_cache` for minutes at a time.
 */
const TOKEN_REJECTIONS = [
  { code: 'PGRST301', message: 'JWT expired' },
  { code: 'PGRST303', message: 'JWT issued at future' },
];

describe('isRetryableAuthError', () => {
  it.each(TOKEN_REJECTIONS)('treats $code as retryable', rejection => {
    expect(isRetryableAuthError(rejection)).toBe(true);
  });

  it('does not treat a policy denial or missing row as retryable', () => {
    expect(isRetryableAuthError({ code: 'PGRST116', message: 'no rows' })).toBe(
      false
    );
    expect(
      isRetryableAuthError({ code: '42501', message: 'permission denied' })
    ).toBe(false);
    expect(isRetryableAuthError(null)).toBe(false);
    expect(isRetryableAuthError(new Error('boom'))).toBe(false);
  });
});

describe('retryOnAuthFailure', () => {
  it('re-runs the query once after a token rejection', async () => {
    const query = vi
      .fn<[], Promise<{ data: unknown; error: unknown }>>()
      .mockResolvedValueOnce({ data: null, error: TOKEN_REJECTIONS[1] })
      .mockResolvedValueOnce({ data: { id: 'p1' }, error: null });

    const result = await retryOnAuthFailure(query, 0);

    expect(query).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual({ id: 'p1' });
  });

  it('returns the error untouched when the retry also fails', async () => {
    const query = vi
      .fn<[], Promise<{ data: unknown; error: unknown }>>()
      .mockResolvedValue({ data: null, error: TOKEN_REJECTIONS[0] });

    const result = await retryOnAuthFailure(query, 0);

    expect(query).toHaveBeenCalledTimes(2);
    expect(result.error).toBe(TOKEN_REJECTIONS[0]);
  });

  it('never retries a non-auth failure', async () => {
    const denial = { code: '42501', message: 'permission denied' };
    const query = vi
      .fn<[], Promise<{ data: unknown; error: unknown }>>()
      .mockResolvedValue({ data: null, error: denial });

    await retryOnAuthFailure(query, 0);

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('toAuthUnavailableError', () => {
  it('preserves the PostgREST code so callers can still branch on it', () => {
    const wrapped = toAuthUnavailableError(TOKEN_REJECTIONS[1]);

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toContain('JWT issued at future');
    expect(isRetryableAuthError(wrapped)).toBe(true);
  });
});

function supabaseRespondingWith(error: unknown) {
  // Chainable enough for `.select().eq().eq().single()`.
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq']) {
    builder[method] = () => builder;
  }
  builder.single = async () => ({ data: null, error });

  return { from: () => builder };
}

describe('getProblemSetBasic', () => {
  it('throws instead of returning null on a token rejection', async () => {
    const supabase = supabaseRespondingWith(TOKEN_REJECTIONS[1]);

    await expect(
      getProblemSetBasic(supabase as any, 'p1', 'user-1', 'user@example.com')
    ).rejects.toThrow(/JWT issued at future/);
  });

  it('still returns null when the row genuinely is not visible', async () => {
    const supabase = supabaseRespondingWith({
      code: 'PGRST116',
      message: 'no rows',
    });

    await expect(
      getProblemSetBasic(supabase as any, 'p1', 'user-1', 'user@example.com')
    ).resolves.toBeNull();
  });
});

describe('checkLimitedAccess', () => {
  it('throws instead of reporting "not shared with you" on a token rejection', async () => {
    const supabase = supabaseRespondingWith(TOKEN_REJECTIONS[1]);

    await expect(
      checkLimitedAccess(supabase as any, 'p1', 'user@example.com')
    ).rejects.toThrow(/JWT issued at future/);
  });

  it('still reports false when the share row is absent', async () => {
    const supabase = supabaseRespondingWith({
      code: 'PGRST116',
      message: 'no rows',
    });

    await expect(
      checkLimitedAccess(supabase as any, 'p1', 'user@example.com')
    ).resolves.toBe(false);
  });
});

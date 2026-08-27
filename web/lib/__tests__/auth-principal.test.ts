import { describe, expect, it, vi } from 'vitest';
import { getAuthenticatedPrincipal } from '@/lib/supabase/auth-principal';

describe('getAuthenticatedPrincipal', () => {
  it('maps verified JWT claims to the application identity contract', async () => {
    const getClaims = vi.fn().mockResolvedValue({
      data: {
        claims: {
          sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          email: 'learner@example.com',
        },
      },
      error: null,
    });

    await expect(
      getAuthenticatedPrincipal({ auth: { getClaims } } as any)
    ).resolves.toEqual({
      user: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        email: 'learner@example.com',
      },
      error: null,
    });
  });

  it('rejects a claims payload without a subject', async () => {
    const getClaims = vi.fn().mockResolvedValue({
      data: { claims: { email: 'learner@example.com' } },
      error: null,
    });

    const result = await getAuthenticatedPrincipal({
      auth: { getClaims },
    } as any);
    expect(result.user).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
  });

  it('preserves SDK verification errors', async () => {
    const verificationError = new Error('invalid JWT');
    const getClaims = vi.fn().mockResolvedValue({
      data: null,
      error: verificationError,
    });

    await expect(
      getAuthenticatedPrincipal({ auth: { getClaims } } as any)
    ).resolves.toEqual({ user: null, error: verificationError });
  });
});

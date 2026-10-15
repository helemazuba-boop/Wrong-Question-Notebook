import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({ getClaims: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getClaims: mocks.getClaims },
    from: mocks.from,
  }),
}));
import { requireUser } from '@/lib/supabase/requireUser';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockReturnValue(queryResult({ is_active: true }));
  mocks.getClaims.mockResolvedValue({
    data: { claims: { sub: TEST_USER.id, email: TEST_USER.email } },
    error: null,
  });
});
describe('requireUser identity and account status', () => {
  it('denies access when the current account status cannot be read', async () => {
    mocks.from.mockReturnValue(
      queryResult(null, { message: 'backend unavailable' })
    );
    const result = await requireUser();
    expect(result.user).toBeNull();
    expect(result.error?.message).toBe('Account status is unavailable');
  });
  it('denies a token whose account profile no longer exists', async () => {
    mocks.from.mockReturnValue(queryResult());
    expect((await requireUser()).user).toBeNull();
  });
  it('maps a verified identity to the route principal', async () => {
    expect((await requireUser()).user).toEqual(TEST_USER);
  });
  it('rejects a token that cannot be verified', async () => {
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: new Error('invalid JWT'),
    });
    expect((await requireUser()).user).toBeNull();
  });
  it('[AUD-03] rejects an inactive profile even when its JWT remains valid', async () => {
    mocks.from.mockReturnValue(
      queryResult({ id: TEST_USER.id, is_active: false })
    );
    expect((await requireUser()).user).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  from: vi.fn(),
  createServiceClient: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/supabase/auth-principal', () => ({
  getAuthenticatedPrincipal: mocks.principal,
}));
vi.mock('@/lib/supabase-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/supabase-utils')>()),
  createServiceClient: mocks.createServiceClient,
}));
import {
  isCurrentUserAdmin,
  isCurrentUserSuperAdmin,
} from '@/lib/user-management';
import {
  isAdminRole,
  isModeratorRole,
  isSuperAdminRole,
} from '@/lib/supabase-utils';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.principal.mockResolvedValue({ user: TEST_USER });
  mocks.createServiceClient.mockReturnValue({ from: mocks.from });
});

describe('role permission predicates', () => {
  it.each([
    ['user', false, false, false],
    ['moderator', false, false, true],
    ['admin', true, false, true],
    ['super_admin', true, true, true],
  ] as const)(
    'resolves %s without treating every elevated role as a super admin',
    async (role, admin, superAdmin, moderator) => {
      const read = queryResult({ user_role: role });
      mocks.from.mockReturnValue(read);
      expect(isAdminRole(role)).toBe(admin);
      expect(isSuperAdminRole(role)).toBe(superAdmin);
      expect(isModeratorRole(role)).toBe(moderator);
      expect(await isCurrentUserAdmin()).toBe(admin);
      expect(await isCurrentUserSuperAdmin()).toBe(superAdmin);
      expect(read.eq).toHaveBeenCalledWith('id', TEST_USER.id);
    }
  );
  it('does not consult the privileged database for an anonymous identity', async () => {
    mocks.principal.mockResolvedValue({ user: null });
    expect(await isCurrentUserAdmin()).toBe(false);
    expect(await isCurrentUserSuperAdmin()).toBe(false);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
  it('denies privileges when no profile is available', async () => {
    mocks.from.mockReturnValue(queryResult());
    expect(await isCurrentUserAdmin()).toBe(false);
    expect(await isCurrentUserSuperAdmin()).toBe(false);
  });
});

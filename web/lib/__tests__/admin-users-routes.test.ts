import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  request,
  params,
  TEST_USER,
  SUBJECT_ID,
} from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  isSuperAdmin: vi.fn(),
  list: vi.fn(),
  profile: vi.fn(),
  currentProfile: vi.fn(),
  updateRole: vi.fn(),
  updateProfile: vi.fn(),
  deleteUser: vi.fn(),
  principal: vi.fn(),
}));
vi.mock('@/lib/user-management', () => ({
  isCurrentUserSuperAdmin: mocks.isSuperAdmin,
  getAllUsersWithCount: mocks.list,
  getUserProfileWithServiceRole: mocks.profile,
  getUserProfile: mocks.currentProfile,
  updateUserRole: mocks.updateRole,
  updateUserProfile: mocks.updateProfile,
  deleteUser: mocks.deleteUser,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/supabase/auth-principal', () => ({
  getAuthenticatedPrincipal: mocks.principal,
}));
import { GET as list } from '@/app/api/admin/users/route';
import {
  GET as detail,
  DELETE as remove,
} from '@/app/api/admin/users/[id]/route';
import { PATCH as changeRole } from '@/app/api/admin/users/[id]/role/route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isSuperAdmin.mockResolvedValue(true);
  mocks.principal.mockResolvedValue({ user: TEST_USER });
  mocks.profile.mockResolvedValue({ id: SUBJECT_ID, user_role: 'user' });
  mocks.currentProfile.mockResolvedValue({ user_role: 'super_admin' });
  mocks.updateRole.mockResolvedValue(true);
  mocks.deleteUser.mockResolvedValue(true);
});

describe('admin user management', () => {
  it('blocks ordinary accounts before listing any user data', async () => {
    mocks.isSuperAdmin.mockResolvedValue(false);
    expect(
      (await list(request('/api/admin/users', undefined, 'GET'))).status
    ).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('caps page size and preserves the requested filters and sort direction', async () => {
    mocks.list.mockResolvedValue({
      users: [{ id: SUBJECT_ID }],
      total_count: 250,
    });
    const response = await list(
      request(
        '/api/admin/users?page=2&limit=200&search=alex&role=user&sort=username&dir=asc',
        undefined,
        'GET'
      )
    );
    expect(mocks.list).toHaveBeenCalledWith(
      100,
      100,
      'alex',
      'user',
      'username',
      'asc'
    );
    expect(await response.json()).toMatchObject({
      page: 2,
      limit: 100,
      total_count: 250,
    });
  });
  it('returns 404 for a missing profile', async () => {
    mocks.profile.mockResolvedValue(null);
    expect(
      (
        await detail(
          request('/api/admin/users/id', undefined, 'GET'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(404);
  });
  it.each(['owner', '', null])(
    'rejects unknown role %s without updating the account',
    async role => {
      expect(
        (
          await changeRole(
            request('/api/admin/users/id/role', { role }, 'PATCH'),
            params(SUBJECT_ID)
          )
        ).status
      ).toBe(400);
      expect(mocks.updateRole).not.toHaveBeenCalled();
    }
  );
  it('prevents changing the current administrator role', async () => {
    expect(
      (
        await changeRole(
          request('/api/admin/users/id/role', { role: 'user' }, 'PATCH'),
          params(TEST_USER.id)
        )
      ).status
    ).toBe(403);
    expect(mocks.updateRole).not.toHaveBeenCalled();
  });
  it('requires a signed-in identity even after the outer admin check', async () => {
    mocks.principal.mockResolvedValue({ user: null });
    expect(
      (
        await changeRole(
          request('/api/admin/users/id/role', { role: 'admin' }, 'PATCH'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(401);
    expect(mocks.updateRole).not.toHaveBeenCalled();
  });
  it('allows a super administrator to assign a supported role to another user', async () => {
    const response = await changeRole(
      request('/api/admin/users/id/role', { role: 'moderator' }, 'PATCH'),
      params(SUBJECT_ID)
    );
    expect(response.status).toBe(200);
    expect(mocks.updateRole).toHaveBeenCalledWith(SUBJECT_ID, 'moderator');
  });
  it('does not report a role change when persistence fails', async () => {
    mocks.updateRole.mockResolvedValue(false);
    expect(
      (
        await changeRole(
          request('/api/admin/users/id/role', { role: 'user' }, 'PATCH'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(500);
  });
  it('prevents deleting a super administrator', async () => {
    mocks.profile.mockResolvedValue({ user_role: 'super_admin' });
    expect(
      (
        await remove(
          request('/api/admin/users/id', undefined, 'DELETE'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(403);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it('prevents self-deletion through the administrator endpoint', async () => {
    expect(
      (
        await remove(
          request('/api/admin/users/id', undefined, 'DELETE'),
          params(TEST_USER.id)
        )
      ).status
    ).toBe(403);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it('reports failure when account cleanup fails', async () => {
    mocks.deleteUser.mockResolvedValue(false);
    expect(
      (
        await remove(
          request('/api/admin/users/id', undefined, 'DELETE'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(500);
  });
  it('delegates deletion of another ordinary account to the cleanup service', async () => {
    expect(
      (
        await remove(
          request('/api/admin/users/id', undefined, 'DELETE'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(200);
    expect(mocks.deleteUser).toHaveBeenCalledWith(SUBJECT_ID);
  });
});

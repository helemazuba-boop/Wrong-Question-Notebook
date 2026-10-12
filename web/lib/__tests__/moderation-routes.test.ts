import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryResult,
  request,
  params,
  TEST_USER,
  SET_ID,
} from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  permitted: vi.fn(),
  service: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({ requireUser: mocks.user }));
vi.mock('@/lib/user-management', () => ({
  isCurrentUserModerator: mocks.permitted,
}));
vi.mock('@/lib/supabase-utils', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemSet: mocks.invalidate,
  revalidateUserProblemSets: mocks.invalidate,
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
import { GET as list } from '@/app/api/admin/reports/route';
import {
  GET as context,
  PATCH as resolve,
} from '@/app/api/admin/reports/[id]/route';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ user: TEST_USER });
  mocks.permitted.mockResolvedValue(true);
  mocks.service.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
});
describe('report moderation authorization and resolution', () => {
  it('denies ordinary users before exposing the privileged queue or context', async () => {
    mocks.permitted.mockResolvedValue(false);
    expect(
      (await list(request('/api/admin/reports', undefined, 'GET'))).status
    ).toBe(403);
    expect(
      (
        await context(
          request('/api/admin/reports/id', undefined, 'GET'),
          params(SET_ID)
        )
      ).status
    ).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('does not misrepresent a failed queue read as an empty queue', async () => {
    mocks.from.mockReturnValue(queryResult(null, { message: 'offline' }));
    expect(
      (await list(request('/api/admin/reports', undefined, 'GET'))).status
    ).toBe(503);
  });
  it('rejects actor spoofing and malformed actions before calling the RPC', async () => {
    for (const body of [
      { action: 'hide', message: 'Reviewed', p_actor_user_id: 'spoof' },
      { action: 'unknown', message: 'Reviewed' },
      { action: 'hide', message: '' },
    ]) {
      expect(
        (
          await resolve(
            request('/api/admin/reports/id', body, 'PATCH'),
            params(SET_ID)
          )
        ).status
      ).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('binds a resolution to the authenticated actor', async () => {
    mocks.rpc.mockResolvedValue({
      data: { id: SET_ID, problem_set_id: null, status: 'dismissed' },
      error: null,
    });
    expect(
      (
        await resolve(
          request(
            '/api/admin/reports/id',
            { action: 'dismiss', message: ' Reviewed ' },
            'PATCH'
          ),
          params(SET_ID)
        )
      ).status
    ).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('resolve_problem_set_report', {
      p_report_id: SET_ID,
      p_actor_user_id: TEST_USER.id,
      p_action: 'dismiss',
      p_message: 'Reviewed',
    });
  });
  it('maps a conflicting review to a retryable conflict', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
    expect(
      (
        await resolve(
          request(
            '/api/admin/reports/id',
            { action: 'hide', message: 'Reviewed' },
            'PATCH'
          ),
          params(SET_ID)
        )
      ).status
    ).toBe(409);
  });
});

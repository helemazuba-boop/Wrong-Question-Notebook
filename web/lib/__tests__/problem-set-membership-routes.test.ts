import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryResult,
  request,
  params,
  TEST_USER,
  SET_ID,
  PROBLEM_ID,
} from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
  userSets: vi.fn(),
  set: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: () =>
    NextResponse.json({ error: 'Unauthorised' }, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateUserProblemSets: mocks.userSets,
  revalidateProblemSet: mocks.set,
}));
import { DELETE } from '@/app/api/problem-sets/[id]/problems/route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({
    user: TEST_USER,
    supabase: { from: mocks.from },
  });
});
const remove = (body: unknown = { problem_ids: [PROBLEM_ID] }) =>
  DELETE(
    request('/api/problem-sets/id/problems', body, 'DELETE'),
    params(SET_ID)
  );

describe('removing a problem from a set', () => {
  it('rejects anonymous removal without accessing storage', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    expect((await remove()).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each([{ problem_ids: [] }, { problem_ids: ['invalid'] }])(
    'rejects invalid selections before querying ownership',
    async body => {
      expect((await remove(body)).status).toBe(400);
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );
  it('refuses removal when the current account does not own the set', async () => {
    mocks.from.mockReturnValue(queryResult(null, { message: 'not visible' }));
    expect((await remove()).status).toBe(404);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('deletes only this set membership and keeps the canonical problem', async () => {
    const ownership = queryResult({ id: SET_ID, user_id: TEST_USER.id });
    const deletion = queryResult();
    mocks.from.mockReturnValueOnce(ownership).mockReturnValueOnce(deletion);
    const response = await remove();
    expect((await response.json()).data).toMatchObject({
      removed_problem_ids: [PROBLEM_ID],
      removed_count: 1,
    });
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      'problem_sets',
      'problem_set_problems',
    ]);
    expect(deletion.delete).toHaveBeenCalledOnce();
    expect(deletion.eq).toHaveBeenCalledWith('problem_set_id', SET_ID);
    expect(deletion.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    expect(deletion.in).toHaveBeenCalledWith('problem_id', [PROBLEM_ID]);
    expect(mocks.userSets).toHaveBeenCalledWith(TEST_USER.id);
    expect(mocks.set).toHaveBeenCalledWith(SET_ID);
  });
  it('does not acknowledge or refresh failed removals', async () => {
    mocks.from
      .mockReturnValueOnce(queryResult({ id: SET_ID, user_id: TEST_USER.id }))
      .mockReturnValueOnce(queryResult(null, { message: 'delete failed' }));
    expect((await remove()).status).toBe(500);
    expect(mocks.userSets).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});

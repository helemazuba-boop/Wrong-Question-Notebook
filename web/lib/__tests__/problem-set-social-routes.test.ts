import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryResult,
  request,
  params,
  TEST_USER,
  SET_ID,
} from '@/lib/test/supabase-query';
import { PROBLEM_SET_CONSTANTS } from '@/lib/constants';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  serviceFrom: vi.fn(),
  userFrom: vi.fn(),
  createServiceClient: vi.fn(),
  rpc: vi.fn(),
  checkAccess: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: () =>
    NextResponse.json({ error: 'Unauthorised' }, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/problem-set-utils', () => ({
  checkProblemSetAccess: mocks.checkAccess,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateDiscovery: mocks.revalidate,
}));
import { POST as like } from '@/app/api/problem-sets/[id]/like/route';
import { POST as favourite } from '@/app/api/problem-sets/[id]/favourite/route';
import { POST as report } from '@/app/api/problem-sets/[id]/report/route';
import { POST as view } from '@/app/api/problem-sets/[id]/view/route';

const body = {
  reason: PROBLEM_SET_CONSTANTS.REPORT_REASONS[0],
  details: 'Fixture report',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({
    user: TEST_USER,
    supabase: { from: mocks.userFrom },
  });
  mocks.createServiceClient.mockReturnValue({
    from: mocks.serviceFrom,
    rpc: mocks.rpc,
  });
  mocks.serviceFrom.mockReturnValue(
    queryResult({ user_id: 'owner', sharing_level: 'public' })
  );
  mocks.checkAccess.mockResolvedValue(true);
  mocks.revalidate.mockResolvedValue(undefined);
});

describe('community mutation authorization', () => {
  it.each([
    ['like', like],
    ['favourite', favourite],
    ['report', report],
  ] as const)(
    'rejects anonymous %s without creating a privileged client',
    async (name, handler) => {
      mocks.requireUser.mockResolvedValue({ user: null });
      expect(
        (
          await handler(
            request(`/api/problem-sets/id/${name}`, body),
            params(SET_ID)
          )
        ).status
      ).toBe(401);
      expect(mocks.createServiceClient).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['like', like],
    ['favourite', favourite],
    ['report', report],
  ] as const)(
    'hides an inaccessible set from %s and performs no writes',
    async (name, handler) => {
      mocks.checkAccess.mockResolvedValue(false);
      expect(
        (
          await handler(
            request(`/api/problem-sets/id/${name}`, body),
            params(SET_ID)
          )
        ).status
      ).toBe(404);
      expect(mocks.checkAccess).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        TEST_USER.id,
        TEST_USER.email,
        SET_ID
      );
      expect(mocks.userFrom).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );
  it('rejects an invalid identifier before looking up a set', async () => {
    expect(
      (await like(request('/api/problem-sets/id/like'), params('invalid')))
        .status
    ).toBe(400);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
});

describe('likes', () => {
  it('rejects liking a private set even when the owner has access', async () => {
    mocks.serviceFrom.mockReturnValue(
      queryResult({ user_id: TEST_USER.id, sharing_level: 'private' })
    );
    expect(
      (await like(request('/api/problem-sets/id/like'), params(SET_ID))).status
    ).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'returns the atomic toggle result liked=%s with a numeric counter',
    async liked => {
      mocks.rpc.mockResolvedValue({
        data: [{ liked, like_count: '7' }],
        error: null,
      });
      const response = await like(
        request('/api/problem-sets/id/like'),
        params(SET_ID)
      );
      expect((await response.json()).data).toEqual({ liked, like_count: 7 });
      expect(mocks.rpc).toHaveBeenCalledWith('toggle_problem_set_like', {
        p_problem_set_id: SET_ID,
        p_user_id: TEST_USER.id,
      });
      expect(mocks.revalidate).toHaveBeenCalledOnce();
    }
  );
  it('does not publish a successful toggle after an RPC failure', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'database failed' },
    });
    expect(
      (await like(request('/api/problem-sets/id/like'), params(SET_ID))).status
    ).toBe(500);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

describe('favourites', () => {
  it('unfavourites an existing row without inserting it again', async () => {
    const deletion = queryResult([{ user_id: TEST_USER.id }]);
    mocks.userFrom.mockReturnValueOnce(deletion);
    const response = await favourite(
      request('/api/problem-sets/id/favourite'),
      params(SET_ID)
    );
    expect((await response.json()).data).toEqual({ favourited: false });
    expect(mocks.userFrom).toHaveBeenCalledTimes(1);
    expect(deletion.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    expect(deletion.eq).toHaveBeenCalledWith('problem_set_id', SET_ID);
  });
  it('uses an idempotent upsert to favourite when no row existed', async () => {
    const insert = queryResult();
    mocks.userFrom
      .mockReturnValueOnce(queryResult([]))
      .mockReturnValueOnce(insert);
    const response = await favourite(
      request('/api/problem-sets/id/favourite'),
      params(SET_ID)
    );
    expect((await response.json()).data).toEqual({ favourited: true });
    expect(insert.upsert).toHaveBeenCalledWith(
      { user_id: TEST_USER.id, problem_set_id: SET_ID },
      { onConflict: 'user_id,problem_set_id', ignoreDuplicates: true }
    );
  });
  it('does not insert a favourite when the initial deletion fails', async () => {
    mocks.userFrom.mockReturnValue(
      queryResult(null, { message: 'delete failed' })
    );
    expect(
      (
        await favourite(
          request('/api/problem-sets/id/favourite'),
          params(SET_ID)
        )
      ).status
    ).toBe(500);
    expect(mocks.userFrom).toHaveBeenCalledTimes(1);
  });
});

describe('report submission', () => {
  it('validates report reasons before looking up or writing content', async () => {
    expect(
      (
        await report(
          request('/api/problem-sets/id/report', { reason: 'invented' }),
          params(SET_ID)
        )
      ).status
    ).toBe(400);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
  it('persists the authenticated reporter and returns 201', async () => {
    const insert = queryResult();
    mocks.userFrom.mockReturnValue(insert);
    const response = await report(
      request('/api/problem-sets/id/report', body),
      params(SET_ID)
    );
    expect(response.status).toBe(201);
    expect((await response.json()).data).toEqual({ reported: true });
    expect(mocks.userFrom).toHaveBeenCalledWith('problem_set_reports');
    expect(insert.insert).toHaveBeenCalledWith({
      problem_set_id: SET_ID,
      reporter_user_id: TEST_USER.id,
      ...body,
    });
  });
  it('returns a conflict for a duplicate report rather than a second success', async () => {
    mocks.userFrom.mockReturnValue(
      queryResult(null, { code: '23505', message: 'duplicate' })
    );
    expect(
      (
        await report(
          request('/api/problem-sets/id/report', body),
          params(SET_ID)
        )
      ).status
    ).toBe(409);
  });
});

describe('view tracking', () => {
  it('does not record or disclose an inaccessible set', async () => {
    mocks.checkAccess.mockResolvedValue(false);
    expect(
      (await view(request('/api/problem-sets/id/view'), params(SET_ID))).status
    ).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('hashes the signed-in viewer identity instead of passing the raw value as a hash', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await view(request('/api/problem-sets/id/view'), params(SET_ID));
    expect(mocks.rpc).toHaveBeenCalledWith('record_problem_set_view', {
      p_problem_set_id: SET_ID,
      p_viewer_hash: createHash('sha256').update(TEST_USER.id).digest('hex'),
      p_user_id: TEST_USER.id,
    });
  });
  it('allows anonymous public views and hashes only the first forwarded IP and user agent', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const req = request('/api/problem-sets/id/view');
    req.headers.set('x-forwarded-for', '192.0.2.1, 198.51.100.2');
    req.headers.set('user-agent', 'Fixture Browser');
    await view(req, params(SET_ID));
    expect(mocks.checkAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      null,
      SET_ID
    );
    expect(mocks.rpc).toHaveBeenCalledWith('record_problem_set_view', {
      p_problem_set_id: SET_ID,
      p_viewer_hash: createHash('sha256')
        .update('192.0.2.1:Fixture Browser')
        .digest('hex'),
      p_user_id: undefined,
    });
  });
});

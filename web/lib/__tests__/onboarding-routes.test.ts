import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: () =>
    NextResponse.json({ error: 'Unauthorised' }, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
import { GET } from '@/app/api/onboarding/status/route';
import { POST } from '@/app/api/onboarding/complete/route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({
    user: TEST_USER,
    supabase: { from: mocks.from },
  });
});

describe('onboarding routes', () => {
  it.each([GET, POST])(
    'rejects anonymous requests without querying content',
    async handler => {
      mocks.requireUser.mockResolvedValue({ user: null });
      expect((await handler()).status).toBe(401);
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );

  it('returns incomplete steps for an account without learning content', async () => {
    const queries = [
      queryResult(null, null, 0),
      queryResult(null, null, 0),
      queryResult(null, null, 0),
      queryResult(),
      queryResult(),
    ];
    queries.forEach(q => mocks.from.mockReturnValueOnce(q));
    const response = await GET();
    expect((await response.json()).data).toEqual({
      hasSubject: false,
      hasProblem: false,
      hasReviewed: false,
      firstSubjectId: null,
      firstProblemId: null,
      firstProblemSubjectId: null,
    });
    queries.forEach(q =>
      expect(q.eq).toHaveBeenCalledWith('user_id', TEST_USER.id)
    );
  });

  it('provides the first problem subject separately from the first subject', async () => {
    const queries = [
      queryResult(null, null, 2),
      queryResult(null, null, 3),
      queryResult(null, null, 1),
      queryResult({ id: 'first-subject' }),
      queryResult({ id: 'first-problem', subject_id: 'other-subject' }),
    ];
    queries.forEach(q => mocks.from.mockReturnValueOnce(q));
    const response = await GET();
    expect((await response.json()).data).toEqual({
      hasSubject: true,
      hasProblem: true,
      hasReviewed: true,
      firstSubjectId: 'first-subject',
      firstProblemId: 'first-problem',
      firstProblemSubjectId: 'other-subject',
    });
    expect(queries[2].not).toHaveBeenCalledWith(
      'last_reviewed_date',
      'is',
      null
    );
  });

  it('returns an error rather than presenting failed queries as incomplete steps', async () => {
    mocks.from.mockReturnValue(
      queryResult(null, { message: 'database unavailable' })
    );
    expect((await GET()).status).toBe(500);
  });

  it('completes only this account and preserves an existing completion timestamp', async () => {
    const update = queryResult();
    mocks.from.mockReturnValue(update);
    const response = await POST();
    expect((await response.json()).data).toEqual({ completed: true });
    expect(update.update).toHaveBeenCalledWith({
      onboarding_completed_at: expect.any(String),
    });
    expect(update.eq).toHaveBeenCalledWith('id', TEST_USER.id);
    expect(update.is).toHaveBeenCalledWith('onboarding_completed_at', null);
  });

  it('does not acknowledge completion when persistence fails', async () => {
    mocks.from.mockReturnValue(queryResult(null, { message: 'write failed' }));
    expect((await POST()).status).toBe(500);
  });
});

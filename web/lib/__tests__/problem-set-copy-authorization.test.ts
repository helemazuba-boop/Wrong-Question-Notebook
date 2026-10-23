import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryResult,
  request,
  params,
  TEST_USER,
  SET_ID,
  SUBJECT_ID,
  PROBLEM_ID,
} from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  userFrom: vi.fn(),
  serviceFrom: vi.fn(),
  access: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: async () => ({
    user: TEST_USER,
    supabase: { from: mocks.userFrom },
  }),
  unauthorised: () => NextResponse.json({}, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (fn: unknown) => fn,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mocks.serviceFrom, rpc: vi.fn() }),
}));
vi.mock('@/lib/problem-set-utils', () => ({
  checkProblemSetAccess: mocks.access,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateUserProblemSets: vi.fn(),
  revalidateProblemSet: vi.fn(),
  revalidateProblemSetPage: vi.fn(),
  revalidateDiscovery: vi.fn(),
  revalidateSitemap: vi.fn(),
  revalidateUserSubjects: vi.fn(),
  revalidateUserProblems: vi.fn(),
  revalidateSubjectProblems: vi.fn(),
  revalidateUserTags: vi.fn(),
  revalidateSubjectTags: vi.fn(),
}));
vi.mock('@/lib/content-limits', () => ({
  checkContentLimit: async () => ({ allowed: true, remaining: 100 }),
}));
vi.mock('@/lib/problem-marks/copy', () => ({
  createProblemMarkCopyMapping: () => ({ destination_problem_id: PROBLEM_ID }),
  inheritProblemMarksBestEffort: vi.fn(),
}));

import { POST as copyProblem } from '@/app/api/problem-sets/[id]/copy-problem/route';
import { POST as copySet } from '@/app/api/problem-sets/[id]/copy/route';
import { PUT } from '@/app/api/problem-sets/[id]/route';
import { FilterConfigSchema } from '@/lib/schemas';

const sourceSet = {
  id: SET_ID,
  user_id: TEST_USER.id,
  subject_id: SUBJECT_ID,
  is_smart: true,
  filter_config: {},
  allow_copying: true,
};
const copy = () =>
  copyProblem(
    request('/api/problem-sets/id/copy-problem', {
      problem_id: PROBLEM_ID,
      target_subject_id: SUBJECT_ID,
      copy_tags: false,
    }),
    params(SET_ID)
  );
const update = (body: unknown) =>
  PUT(request('/api/problem-sets/id', body, 'PUT'), params(SET_ID));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.userFrom.mockReturnValue(queryResult({ id: SUBJECT_ID }));
});

describe('privileged copy membership boundary', () => {
  it.each(
    [null, undefined, false, 0, '', 'null', [], { tag_ids: 'invalid' }].map(
      value => [value]
    )
  )(
    'rejects smart config %j before reading a source problem or writing',
    async filter_config => {
      mocks.serviceFrom.mockReturnValue(
        queryResult({ ...sourceSet, filter_config })
      );
      expect((await copy()).status).toBe(400);
      expect(mocks.serviceFrom.mock.calls.map(([table]) => table)).toEqual([
        'problem_sets',
      ]);
      expect(mocks.userFrom).not.toHaveBeenCalled();
    }
  );
  it('does not fall back to manual membership for a malformed smart bulk copy', async () => {
    mocks.serviceFrom.mockReturnValue(
      queryResult({ ...sourceSet, filter_config: null })
    );
    expect(
      (
        await copySet(
          request('/api/problem-sets/id/copy', {
            target_subject_id: SUBJECT_ID,
            copy_tags: false,
          }),
          params(SET_ID)
        )
      ).status
    ).toBe(400);
    expect(mocks.serviceFrom).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { days_since_review: null }])(
    'rejects a known foreign problem UUID even with valid broad config %j',
    async filter_config => {
      const membership = queryResult(null, null, 0);
      mocks.serviceFrom
        .mockReturnValueOnce(queryResult({ ...sourceSet, filter_config }))
        .mockReturnValueOnce(membership);
      expect((await copy()).status).toBe(400);
      expect(membership.eq).toHaveBeenCalledWith('id', PROBLEM_ID);
      expect(membership.eq).toHaveBeenCalledWith('user_id', sourceSet.user_id);
      expect(membership.eq).toHaveBeenCalledWith('subject_id', SUBJECT_ID);
      expect(membership.select).toHaveBeenCalledWith('id', {
        count: 'exact',
        head: true,
      });
      expect(mocks.serviceFrom).toHaveBeenCalledTimes(2);
      expect(mocks.userFrom).not.toHaveBeenCalled();
    }
  );
  it('preserves copying a verified smart member, including shared-owner scope', async () => {
    const membership = queryResult(null, null, 1);
    mocks.serviceFrom
      .mockReturnValueOnce(queryResult({ ...sourceSet, user_id: SUBJECT_ID }))
      .mockReturnValueOnce(membership)
      .mockReturnValueOnce(
        queryResult({ id: PROBLEM_ID, title: 'Shared member', parts: [] })
      );
    const insertion = queryResult({ id: PROBLEM_ID });
    mocks.userFrom
      .mockReturnValueOnce(queryResult({ id: SUBJECT_ID }))
      .mockReturnValueOnce(insertion);
    expect((await copy()).status).toBe(201);
    expect(membership.eq).toHaveBeenCalledWith('user_id', SUBJECT_ID);
    expect(insertion.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: TEST_USER.id })
    );
  });
  it.each([true, false])(
    'preserves manual linked=%s membership checks',
    async linked => {
      const link = queryResult(linked ? { problem_id: PROBLEM_ID } : null);
      mocks.serviceFrom
        .mockReturnValueOnce(
          queryResult({ ...sourceSet, is_smart: false, filter_config: null })
        )
        .mockReturnValueOnce(link)
        .mockReturnValueOnce(queryResult({ id: PROBLEM_ID, parts: [] }));
      expect((await copy()).status).toBe(linked ? 201 : 400);
      expect(link.eq).toHaveBeenCalledWith('problem_set_id', SET_ID);
      expect(link.eq).toHaveBeenCalledWith('problem_id', PROBLEM_ID);
    }
  );
});

describe('partial update effective smart state', () => {
  it('rejects clearing the filter while leaving persisted smart mode unchanged', async () => {
    const existing = queryResult(sourceSet);
    mocks.userFrom.mockReturnValue(existing);
    expect((await update({ filter_config: null })).status).toBe(400);
    expect(existing.update).not.toHaveBeenCalled();
  });
  it('rejects enabling smart mode without an effective filter', async () => {
    const existing = queryResult({
      ...sourceSet,
      is_smart: false,
      filter_config: null,
    });
    mocks.userFrom.mockReturnValue(existing);
    expect((await update({ is_smart: true })).status).toBe(400);
    expect(existing.update).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'Renamed' },
    { filter_config: {} },
    { is_smart: true },
    { is_smart: false, filter_config: null },
  ])(
    'preserves valid partial updates without persisting schema defaults: %j',
    async body => {
      const mutation = queryResult({ ...sourceSet, ...body });
      mocks.userFrom
        .mockReturnValueOnce(queryResult(sourceSet))
        .mockReturnValueOnce(mutation);
      expect((await update(body)).status).toBe(200);
      expect(mutation.update).toHaveBeenCalledWith({
        ...body,
        ...('filter_config' in body && body.filter_config !== null
          ? { filter_config: FilterConfigSchema.parse(body.filter_config) }
          : {}),
      });
      expect(Object.keys(mutation.update.mock.calls[0][0])).toEqual(
        Object.keys(body)
      );
    }
  );
});

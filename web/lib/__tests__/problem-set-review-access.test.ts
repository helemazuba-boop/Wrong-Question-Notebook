import { isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryResult,
  TEST_USER,
  SUBJECT_ID,
  SET_ID,
  PROBLEM_ID,
} from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  userFrom: vi.fn(),
  serviceFrom: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: mocks.userFrom }),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
}));
vi.mock('@/lib/supabase-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/supabase-utils')>()),
  createServiceClient: () => ({ from: mocks.serviceFrom }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock(
  '@/app/[locale]/(app)/subjects/[id]/problems/[problemId]/review/problem-review',
  () => ({ default: () => null })
);
vi.mock(
  '@/app/[locale]/(app)/problem-sets/[id]/review/session-review-client',
  () => ({ default: () => null })
);
vi.mock('@/components/back-link', () => ({ BackLink: () => null }));
import { checkProblemSetAccess } from '@/lib/problem-set-utils';
import ReviewPage from '@/app/[locale]/(app)/problem-sets/[id]/review/page';

const set = {
  id: SET_ID,
  user_id: 'owner',
  subject_id: SUBJECT_ID,
  name: 'Fixture set',
  sharing_level: 'public',
  is_smart: false,
  allow_copying: true,
};
const problem = {
  id: PROBLEM_ID,
  title: 'Fixture problem',
  subject_id: SUBJECT_ID,
  parts: [],
  assets: [],
  solution_assets: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ user: TEST_USER });
  mocks.userFrom.mockImplementation(table =>
    queryResult(table === 'subjects' ? { name: 'Math' } : set)
  );
  mocks.serviceFrom.mockImplementation(table => {
    if (table === 'problem_sets') return queryResult(set);
    if (table === 'subjects') return queryResult({ name: 'Math' });
    if (table === 'problem_set_problems')
      return queryResult([{ problem_id: PROBLEM_ID, problems: problem }]);
    if (table === 'problem_tag') return queryResult([]);
    throw new Error(`Unexpected privileged query: ${table}`);
  });
});
const page = () =>
  ReviewPage({
    params: Promise.resolve({ id: SET_ID }),
    searchParams: Promise.resolve({ problemId: PROBLEM_ID }),
  });

describe('problem set access policy', () => {
  it.each([
    ['public', null, true],
    ['private', null, false],
    ['limited', null, false],
    ['private', 'owner', true],
    ['private', TEST_USER.id, false],
    ['public', TEST_USER.id, true],
  ] as const)('checks %s for user %s', async (sharing_level, user, allowed) => {
    expect(
      await checkProblemSetAccess(
        { from: mocks.userFrom },
        { user_id: 'owner', sharing_level },
        user,
        TEST_USER.email,
        SET_ID
      )
    ).toBe(allowed);
    expect(mocks.userFrom).not.toHaveBeenCalled();
  });
  it('requires the limited-sharing grant for a non-owner', async () => {
    const share = queryResult({ id: 'grant' });
    mocks.userFrom.mockReturnValue(share);
    expect(
      await checkProblemSetAccess(
        { from: mocks.userFrom },
        { user_id: 'owner', sharing_level: 'limited' },
        TEST_USER.id,
        TEST_USER.email,
        SET_ID
      )
    ).toBe(true);
    expect(share.eq).toHaveBeenCalledWith('problem_set_id', SET_ID);
    expect(share.eq).toHaveBeenCalledWith('shared_with_email', TEST_USER.email);
    mocks.userFrom.mockReturnValue(queryResult());
    expect(
      await checkProblemSetAccess(
        { from: mocks.userFrom },
        { user_id: 'owner', sharing_level: 'limited' },
        TEST_USER.id,
        TEST_USER.email,
        SET_ID
      )
    ).toBe(false);
  });
});

describe('single-problem review through a shared set', () => {
  it('renders a public single-problem deep link for an anonymous reader', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    const result = await page();
    expect(isValidElement(result)).toBe(true);
    const element = result as ReactElement<{
      problem: { id: string };
      isReadOnly: boolean;
      isAuthenticated: boolean;
    }>;
    expect(element.props.problem.id).toBe(PROBLEM_ID);
    expect(element.props.isReadOnly).toBe(true);
    expect(element.props.isAuthenticated).toBe(false);
  });
  it('redirects anonymous readers away from a limited-sharing set', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    mocks.serviceFrom.mockReturnValue(
      queryResult({ ...set, sharing_level: 'limited' })
    );
    await expect(page()).rejects.toThrow('redirect:/auth/login');
  });
  it('does not render an unrelated problem identifier from the query string', async () => {
    await expect(
      ReviewPage({
        params: Promise.resolve({ id: SET_ID }),
        searchParams: Promise.resolve({ problemId: SUBJECT_ID }),
      })
    ).rejects.toThrow('notFound');
  });
  it('[AUD-02] rejects a signed-in reader who has no grant to a limited set', async () => {
    // The repository RLS exposes limited set metadata to authenticated users.
    // The normal access helper denies this fixture, but this page omits it.
    mocks.userFrom.mockImplementation(table => {
      if (table === 'problem_set_shares') return queryResult();
      return queryResult(
        table === 'subjects'
          ? { name: 'Math' }
          : { ...set, sharing_level: 'limited' }
      );
    });
    await expect(page()).rejects.toThrow('notFound');
  });
});

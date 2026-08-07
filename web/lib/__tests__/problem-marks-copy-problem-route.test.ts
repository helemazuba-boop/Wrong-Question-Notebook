import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  checkProblemSetAccess: vi.fn(),
  checkContentLimit: vi.fn(),
  inheritProblemMarksBestEffort: vi.fn(),
  createProblemMarkCopyMapping: vi.fn(),
  userClient: {} as any,
  serviceClient: {} as any,
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/problem-set-utils', () => ({
  checkProblemSetAccess: mocks.checkProblemSetAccess,
}));
vi.mock('@/lib/review-utils', () => ({
  isFilteredProblemMember: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => mocks.serviceClient,
}));
vi.mock('@/lib/content-limits', () => ({
  checkContentLimit: mocks.checkContentLimit,
}));
vi.mock('@/lib/problem-marks/copy', () => ({
  createProblemMarkCopyMapping: mocks.createProblemMarkCopyMapping,
  inheritProblemMarksBestEffort: mocks.inheritProblemMarksBestEffort,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateUserSubjects: vi.fn(),
  revalidateUserProblems: vi.fn(),
  revalidateSubjectProblems: vi.fn(),
  revalidateUserTags: vi.fn(),
  revalidateSubjectTags: vi.fn(),
  revalidateDiscovery: vi.fn(),
}));

import { POST } from '@/app/api/problem-sets/[id]/copy-problem/route';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOURCE_PROBLEM_ID = '11111111-1111-4111-8111-111111111111';
const DESTINATION_PROBLEM_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';

function resolvedBuilder(result: unknown) {
  const chain: any = {};
  for (const method of ['select', 'eq', 'in']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkProblemSetAccess.mockResolvedValue(true);
  mocks.checkContentLimit.mockResolvedValue({ allowed: true, remaining: 100 });
  mocks.createProblemMarkCopyMapping.mockReturnValue({
    source_problem_id: SOURCE_PROBLEM_ID,
    destination_problem_id: DESTINATION_PROBLEM_ID,
  });
  mocks.inheritProblemMarksBestEffort.mockResolvedValue({
    inherited: 0,
    pending: 1,
  });

  let problemInsert: Record<string, unknown> | null = null;
  const userFrom = vi.fn((table: string) => {
    if (table === 'subjects') {
      return resolvedBuilder({ data: { id: SUBJECT_ID }, error: null });
    }
    if (table === 'tags') {
      return resolvedBuilder({ data: [], error: null });
    }
    if (table === 'problems') {
      const chain = resolvedBuilder({
        data: { id: DESTINATION_PROBLEM_ID },
        error: null,
      });
      chain.insert = vi.fn((value: Record<string, unknown>) => {
        problemInsert = value;
        return chain;
      });
      return chain;
    }
    if (table === 'problem_tag') {
      const chain = resolvedBuilder({ data: null, error: null });
      chain.insert = vi.fn(() => chain);
      return chain;
    }
    throw new Error(`Unexpected user table: ${table}`);
  });
  mocks.userClient = { from: userFrom };
  mocks.requireUser.mockResolvedValue({
    user: { id: USER_ID, email: 'user@example.com' },
    supabase: mocks.userClient,
  });

  const serviceFrom = vi.fn((table: string) => {
    if (table === 'problem_sets') {
      return resolvedBuilder({
        data: {
          id: SET_ID,
          user_id: 'owner-id',
          subject_id: SUBJECT_ID,
          sharing_level: 'public',
          allow_copying: true,
          is_smart: false,
        },
        error: null,
      });
    }
    if (table === 'problem_set_problems') {
      return resolvedBuilder({
        data: { problem_id: SOURCE_PROBLEM_ID },
        error: null,
      });
    }
    if (table === 'problems') {
      return resolvedBuilder({
        data: {
          id: SOURCE_PROBLEM_ID,
          title: 'Duplicate-safe problem',
          content: 'Same content is allowed.',
          parts: [],
          source: {},
          is_optional: false,
          solution_text: null,
          assets: [],
          solution_assets: [],
          problem_tag: [],
        },
        error: null,
      });
    }
    throw new Error(`Unexpected service table: ${table}`);
  });
  mocks.serviceClient = {
    from: serviceFrom,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  Object.defineProperty(mocks, 'problemInsert', {
    configurable: true,
    get: () => problemInsert,
  });
});

describe('single Problem Copy Mark inheritance', () => {
  it('keeps the copied Problem when Mark inheritance remains pending', async () => {
    const request = new Request(
      `http://localhost/api/problem-sets/${SET_ID}/copy-problem`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          problem_id: SOURCE_PROBLEM_ID,
          target_subject_id: SUBJECT_ID,
          copy_tags: false,
        }),
      }
    );

    const response = await POST(request as never, {
      params: Promise.resolve({ id: SET_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      problem_id: DESTINATION_PROBLEM_ID,
      marks: { inherited: 0, pending: 1 },
    });
    expect((mocks as any).problemInsert).toMatchObject({
      id: DESTINATION_PROBLEM_ID,
      user_id: USER_ID,
      subject_id: SUBJECT_ID,
    });
    expect(mocks.inheritProblemMarksBestEffort).toHaveBeenCalledWith(
      mocks.serviceClient,
      [
        {
          source_problem_id: SOURCE_PROBLEM_ID,
          destination_problem_id: DESTINATION_PROBLEM_ID,
        },
      ]
    );
  });
});

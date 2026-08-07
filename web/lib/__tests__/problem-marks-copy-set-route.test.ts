import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  checkProblemSetAccess: vi.fn(),
  checkContentLimit: vi.fn(),
  inheritProblemMarksBestEffort: vi.fn(),
  createProblemMarkCopyMapping: vi.fn(),
  serviceClient: {} as any,
  insertedProblems: [] as Array<Record<string, unknown>>,
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
  getFilteredProblems: vi.fn(),
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
  revalidateUserProblemSets: vi.fn(),
  revalidateDiscovery: vi.fn(),
}));

import { POST } from '@/app/api/problem-sets/[id]/copy/route';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';
const NEW_SET_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
const DESTINATION_IDS = [
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
];

function builder(result: unknown) {
  const chain: any = {};
  for (const method of ['select', 'eq', 'in', 'delete']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertedProblems = [];
  mocks.checkProblemSetAccess.mockResolvedValue(true);
  mocks.checkContentLimit.mockResolvedValue({ allowed: true, remaining: 100 });
  SOURCE_IDS.forEach((sourceId, index) => {
    mocks.createProblemMarkCopyMapping.mockReturnValueOnce({
      source_problem_id: sourceId,
      destination_problem_id: DESTINATION_IDS[index],
    });
  });
  mocks.inheritProblemMarksBestEffort.mockResolvedValue({
    inherited: 0,
    pending: 2,
  });

  const duplicateProblems = SOURCE_IDS.map(id => ({
    id,
    title: 'Duplicate title',
    content: 'Duplicate content',
    parts: [],
    source: {},
    is_optional: false,
    solution_text: null,
    assets: [],
    solution_assets: [],
    problem_tag: [],
  }));
  const serviceFrom = vi.fn((table: string) => {
    if (table !== 'problem_sets')
      throw new Error(`Unexpected service table: ${table}`);
    return builder({
      data: {
        id: SET_ID,
        user_id: 'owner-id',
        subject_id: SUBJECT_ID,
        name: 'Source set',
        description: null,
        sharing_level: 'public',
        allow_copying: true,
        is_smart: false,
        filter_config: null,
        problem_set_problems: duplicateProblems.map(problem => ({
          problem_id: problem.id,
          problems: problem,
        })),
      },
      error: null,
    });
  });
  mocks.serviceClient = {
    from: serviceFrom,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  const userFrom = vi.fn((table: string) => {
    if (table === 'subjects') {
      return builder({ data: { id: SUBJECT_ID }, error: null });
    }
    if (table === 'problems') {
      const chain = builder({
        data: DESTINATION_IDS.map(id => ({ id })),
        error: null,
      });
      chain.insert = vi.fn((values: Array<Record<string, unknown>>) => {
        mocks.insertedProblems = values;
        return chain;
      });
      return chain;
    }
    if (table === 'problem_sets') {
      const chain = builder({ data: { id: NEW_SET_ID }, error: null });
      chain.insert = vi.fn(() => chain);
      return chain;
    }
    if (table === 'problem_set_problems') {
      const chain = builder({ data: null, error: null });
      chain.insert = vi.fn(() => chain);
      return chain;
    }
    throw new Error(`Unexpected user table: ${table}`);
  });
  mocks.requireUser.mockResolvedValue({
    user: { id: USER_ID, email: 'user@example.com' },
    supabase: { from: userFrom },
  });
});

describe('whole Problem Set Copy Mark inheritance', () => {
  it('uses explicit UUID mappings even when Problems have duplicate title/content', async () => {
    const request = new Request(
      `http://localhost/api/problem-sets/${SET_ID}/copy`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
    expect(mocks.insertedProblems.map(problem => problem.id)).toEqual(
      DESTINATION_IDS
    );
    expect(mocks.inheritProblemMarksBestEffort).toHaveBeenCalledWith(
      mocks.serviceClient,
      SOURCE_IDS.map((sourceId, index) => ({
        source_problem_id: sourceId,
        destination_problem_id: DESTINATION_IDS[index],
      }))
    );
    expect(body.data).toMatchObject({
      problem_set_id: NEW_SET_ID,
      problem_count: 2,
      marks: { inherited: 0, pending: 2 },
    });
  });
});

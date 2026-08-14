import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  setProblemInitialIdea: vi.fn(),
  readProblemInitialIdea: vi.fn(),
  revalidateProblemComprehensive: vi.fn(),
  wakeProblemMarkAnnotation: vi.fn(),
  readProblemSemantics: vi.fn(),
  deleteProblemFiles: vi.fn(),
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemComprehensive: mocks.revalidateProblemComprehensive,
}));
vi.mock('@/lib/problem-image-service', () => ({
  deriveProblemImageAssets: vi.fn(async assets => assets),
}));
vi.mock('@/lib/problem-marks/wake', () => ({
  wakeProblemMarkAnnotation: mocks.wakeProblemMarkAnnotation,
}));
vi.mock('@/lib/problem-marks/read', () => ({
  readProblemSemantics: mocks.readProblemSemantics,
}));
vi.mock('@/lib/problem-initial-idea', () => ({
  setProblemInitialIdea: mocks.setProblemInitialIdea,
  readProblemInitialIdea: mocks.readProblemInitialIdea,
}));
vi.mock('@/lib/storage/delete', () => ({
  deleteProblemFiles: mocks.deleteProblemFiles,
}));

import { PATCH } from '@/app/api/problems/[id]/route';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROBLEM_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';

type Result = { data: any; error: any };

function builder(result: Result) {
  const chain: any = {};
  for (const method of ['select', 'eq', 'insert', 'update', 'delete']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (value: Result) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

function request(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/problems/${PROBLEM_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: PROBLEM_ID }) };

function mockSupabase() {
  const updatedProblem = builder({
    data: {
      id: PROBLEM_ID,
      user_id: USER_ID,
      subject_id: SUBJECT_ID,
      title: '更新后的题目',
    },
    error: null,
  });
  const tags = builder({ data: [], error: null });
  const from = vi.fn((table: string) =>
    table === 'problems' ? updatedProblem : tags
  );
  mocks.requireUser.mockResolvedValue({
    user: { id: USER_ID },
    supabase: { from },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readProblemInitialIdea.mockResolvedValue(null);
  mocks.setProblemInitialIdea.mockResolvedValue({ revision: 1 });
});

describe('Problem PATCH annotation wake', () => {
  it('wakes annotation when objective Problem fields change', async () => {
    mockSupabase();
    const response = await PATCH(request({ title: '更新后的题目' }), params);
    expect(response.status).toBe(200);
    expect(mocks.wakeProblemMarkAnnotation).toHaveBeenCalledWith(PROBLEM_ID);
  });

  it('does not wake annotation for a personal initial-idea-only edit', async () => {
    mockSupabase();
    const response = await PATCH(
      request({ initial_idea: '我的想法变了。' }),
      params
    );
    expect(response.status).toBe(200);
    expect(mocks.wakeProblemMarkAnnotation).not.toHaveBeenCalled();
  });
});

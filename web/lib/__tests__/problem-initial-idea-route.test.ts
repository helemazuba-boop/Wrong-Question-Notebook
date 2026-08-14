import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  setProblemInitialIdea: vi.fn(),
  readProblemInitialIdea: vi.fn(),
  revalidateProblemComprehensive: vi.fn(),
  wakeProblemMarkAnnotation: vi.fn(),
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/problem-initial-idea', () => ({
  setProblemInitialIdea: mocks.setProblemInitialIdea,
  readProblemInitialIdea: mocks.readProblemInitialIdea,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemComprehensive: mocks.revalidateProblemComprehensive,
}));
vi.mock('@/lib/problem-image-service', () => ({
  deriveProblemImageAssets: vi.fn(async assets => assets),
}));
vi.mock('@/lib/storage/delete', () => ({
  deleteProblemFiles: vi.fn(),
}));
vi.mock('@/lib/problem-marks/read', () => ({
  readProblemSemantics: vi.fn(),
}));
vi.mock('@/lib/problem-marks/wake', () => ({
  wakeProblemMarkAnnotation: mocks.wakeProblemMarkAnnotation,
}));

import { PATCH } from '@/app/api/problems/[id]/route';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROBLEM_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';

type Result = { data: unknown; error: unknown };

function builder(result: Result) {
  const chain: any = {};
  for (const method of ['select', 'eq', 'update', 'delete', 'insert']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (value: Result) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

function makeSupabase() {
  const objectiveUpdate = builder({ data: { id: PROBLEM_ID }, error: null });
  const fetchProblem = builder({
    data: {
      id: PROBLEM_ID,
      user_id: USER_ID,
      subject_id: SUBJECT_ID,
      title: 'Updated',
    },
    error: null,
  });
  const tags = builder({ data: [], error: null });
  let problemCalls = 0;
  const from = vi.fn((table: string) => {
    if (table === 'problems') {
      problemCalls += 1;
      return problemCalls === 1 ? objectiveUpdate : fetchProblem;
    }
    return tags;
  });
  return { from, objectiveUpdate };
}

function patch(body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/problems/${PROBLEM_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROBLEM_ID }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setProblemInitialIdea.mockResolvedValue({
    revision_id: '22222222-2222-4222-8222-222222222222',
    revision: 2,
    revision_kind: 'set',
    idea: '新的原话',
  });
  mocks.readProblemInitialIdea.mockResolvedValue({
    revision_id: '22222222-2222-4222-8222-222222222222',
    revision: 2,
    revision_kind: 'set',
    idea: '新的原话',
  });
});

describe('Problem PATCH initial idea', () => {
  it('keeps personal context out of the objective Problem update', async () => {
    const { from, objectiveUpdate } = makeSupabase();
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });

    const response = await patch({
      title: 'Updated',
      initial_idea: '新的原话',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(objectiveUpdate.update).toHaveBeenCalledWith({ title: 'Updated' });
    expect(mocks.setProblemInitialIdea).toHaveBeenCalledWith(
      expect.anything(),
      PROBLEM_ID,
      '新的原话'
    );
    expect(body.data).toMatchObject({
      initial_idea: '新的原话',
      initial_idea_revision: 2,
    });
  });

  it('maps an explicit null to a clear and skips an empty objective update', async () => {
    const fetchProblem = builder({
      data: {
        id: PROBLEM_ID,
        user_id: USER_ID,
        subject_id: SUBJECT_ID,
        title: 'Unchanged',
      },
      error: null,
    });
    const tags = builder({ data: [], error: null });
    const from = vi.fn((table: string) =>
      table === 'problems' ? fetchProblem : tags
    );
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });
    mocks.setProblemInitialIdea.mockResolvedValue({
      revision_id: '22222222-2222-4222-8222-222222222222',
      revision: 3,
      revision_kind: 'clear',
      idea: null,
    });
    mocks.readProblemInitialIdea.mockResolvedValue({
      revision_id: '22222222-2222-4222-8222-222222222222',
      revision: 3,
      revision_kind: 'clear',
      idea: null,
    });

    const response = await patch({ initial_idea: null });

    expect(response.status).toBe(200);
    expect(fetchProblem.update).not.toHaveBeenCalled();
    expect(mocks.setProblemInitialIdea).toHaveBeenCalledWith(
      expect.anything(),
      PROBLEM_ID,
      null
    );
  });

  it('reports a durable objective update as incomplete when context save fails', async () => {
    const { from, objectiveUpdate } = makeSupabase();
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });
    mocks.setProblemInitialIdea.mockRejectedValue(
      new Error('initial idea RPC unavailable')
    );

    const response = await patch({
      title: 'Updated',
      initial_idea: '需要重试',
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(objectiveUpdate.update).toHaveBeenCalledWith({ title: 'Updated' });
    expect(body.error).toBe(
      'Problem updated, but the initial idea was not saved'
    );
    expect(body.details).toEqual({
      code: 'INITIAL_IDEA_SAVE_FAILED',
      problem_id: PROBLEM_ID,
      retryable: true,
    });
  });
});

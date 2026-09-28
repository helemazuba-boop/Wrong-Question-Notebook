import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  setProblemInitialIdea: vi.fn(),
  readProblemInitialIdea: vi.fn(),
  checkContentLimit: vi.fn(),
  revalidateProblemComprehensive: vi.fn(),
  wakeProblemMarkAnnotation: vi.fn(),
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/problem-initial-idea', () => ({
  setProblemInitialIdea: mocks.setProblemInitialIdea,
  readProblemInitialIdea: mocks.readProblemInitialIdea,
}));
vi.mock('@/lib/content-limits', () => ({
  checkContentLimit: mocks.checkContentLimit,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemComprehensive: mocks.revalidateProblemComprehensive,
}));
vi.mock('@/lib/problem-image-service', () => ({
  deriveProblemImageAssets: vi.fn(async assets => assets),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));
vi.mock('@/lib/problem-marks/wake', () => ({
  wakeProblemMarkAnnotation: mocks.wakeProblemMarkAnnotation,
}));

import { POST } from '@/app/api/problems/route';

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

function request() {
  return new Request('http://localhost/api/problems', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: PROBLEM_ID,
      subject_id: SUBJECT_ID,
      title: '创建中的题目',
      parts: [{ index: 1, type: 'essay' }],
      initial_idea: '我先画了辅助线。',
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkContentLimit.mockResolvedValue({ allowed: true });
  mocks.readProblemInitialIdea.mockResolvedValue(null);
  mocks.setProblemInitialIdea.mockResolvedValue({
    revision_id: '22222222-2222-4222-8222-222222222222',
    revision: 1,
    revision_kind: 'set',
    idea: '我先画了辅助线。',
  });
});

describe('Problem POST initial idea', () => {
  it('creates the objective Problem first, then appends private context', async () => {
    const existing = builder({ data: null, error: null });
    const inserted = builder({
      data: {
        id: PROBLEM_ID,
        user_id: USER_ID,
        subject_id: SUBJECT_ID,
        title: '创建中的题目',
      },
      error: null,
    });
    const tags = builder({ data: [], error: null });
    const ownedSubject = builder({ data: { id: SUBJECT_ID }, error: null });
    let problemCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === 'problems') {
        problemCalls += 1;
        return problemCalls === 1 ? existing : inserted;
      }
      if (table === 'subjects') return ownedSubject;
      return tags;
    });
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });

    const response = await POST(request() as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(inserted.insert).toHaveBeenCalledWith(
      expect.not.objectContaining({ initial_idea: expect.anything() })
    );
    expect(mocks.setProblemInitialIdea).toHaveBeenCalledWith(
      expect.anything(),
      PROBLEM_ID,
      '我先画了辅助线。'
    );
    expect(body.data).toMatchObject({
      id: PROBLEM_ID,
      initial_idea: '我先画了辅助线。',
      initial_idea_revision: 1,
    });
    // A fresh Problem always wakes best-effort annotation for its own id.
    expect(mocks.wakeProblemMarkAnnotation).toHaveBeenCalledWith(PROBLEM_ID);
  });

  it('repairs context on an idempotent retry after the Problem already committed', async () => {
    const existing = builder({
      data: {
        id: PROBLEM_ID,
        user_id: USER_ID,
        subject_id: SUBJECT_ID,
        title: '创建中的题目',
      },
      error: null,
    });
    const tags = builder({ data: [], error: null });
    const ownedSubject = builder({ data: { id: SUBJECT_ID }, error: null });
    const from = vi.fn((table: string) => {
      if (table === 'problems') return existing;
      if (table === 'subjects') return ownedSubject;
      return tags;
    });
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });

    const response = await POST(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(existing.insert).not.toHaveBeenCalled();
    expect(mocks.setProblemInitialIdea).toHaveBeenCalledWith(
      expect.anything(),
      PROBLEM_ID,
      '我先画了辅助线。'
    );
    expect(body.data.initial_idea_revision).toBe(1);
  });

  it('does not overwrite an existing context during a duplicate create retry', async () => {
    const existing = builder({
      data: {
        id: PROBLEM_ID,
        user_id: USER_ID,
        subject_id: SUBJECT_ID,
        title: '创建中的题目',
      },
      error: null,
    });
    const ownedSubject = builder({ data: { id: SUBJECT_ID }, error: null });
    const from = vi.fn((table: string) =>
      table === 'subjects' ? ownedSubject : existing
    );
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });
    mocks.readProblemInitialIdea.mockResolvedValue({
      revision_id: '22222222-2222-4222-8222-222222222222',
      revision: 1,
      revision_kind: 'set',
      idea: '已经保存的原话',
    });

    const response = await POST(request() as never);

    expect(response.status).toBe(409);
    expect(mocks.setProblemInitialIdea).not.toHaveBeenCalled();
  });
});

describe('Problem POST subject ownership', () => {
  it('rejects a subject the caller does not own without attempting an insert', async () => {
    const subjects = builder({ data: null, error: null });
    const problems = builder({ data: null, error: null });
    const from = vi.fn((table: string) =>
      table === 'subjects' ? subjects : problems
    );
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });

    const response = await POST(request() as never);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Subject not found');
    expect(problems.insert).not.toHaveBeenCalled();
  });

  it('answers a subject lookup failure as a database error', async () => {
    const subjects = builder({
      data: null,
      error: { message: 'SUBJECT_LOOKUP_FAILED' },
    });
    const problems = builder({ data: null, error: null });
    const from = vi.fn((table: string) =>
      table === 'subjects' ? subjects : problems
    );
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: { from },
    });

    const response = await POST(request() as never);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.details).toBe('SUBJECT_LOOKUP_FAILED');
    expect(problems.insert).not.toHaveBeenCalled();
  });
});

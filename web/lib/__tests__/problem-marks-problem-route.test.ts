import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  readProblemSemantics: vi.fn(),
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/problem-marks/read', () => ({
  readProblemSemantics: mocks.readProblemSemantics,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemComprehensive: vi.fn(),
}));
vi.mock('@/lib/problem-image-service', () => ({
  deriveProblemImageAssets: vi.fn(),
}));
vi.mock('@/lib/storage/delete', () => ({
  deleteProblemFiles: vi.fn(),
}));

import { GET } from '@/app/api/problems/[id]/route';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROBLEM_ID = '11111111-1111-4111-8111-111111111111';

function query(result: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown> =
    {} as never;
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((onfulfilled, onrejected) =>
    Promise.resolve(result).then(onfulfilled, onrejected)
  ) as PromiseLike<unknown>['then'];
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  const problemQuery = query({
    data: { id: PROBLEM_ID, user_id: USER_ID, title: 'Problem' },
    error: null,
  });
  const tagQuery = query({
    data: [{ tags: { id: 'tag-id', name: 'Algebra' } }],
    error: null,
  });
  const from = vi.fn((table: string) =>
    table === 'problems' ? problemQuery : tagQuery
  );
  mocks.requireUser.mockResolvedValue({
    user: { id: USER_ID },
    supabase: { from },
  });
  mocks.readProblemSemantics.mockResolvedValue({
    registry_revision: null,
    semantic_revision: 1,
    annotation_status: 'pending',
    targets: [],
    required: { knowledge: [], skills: [] },
    unresolved: [],
  });
});

describe('Problem GET semantics', () => {
  it('includes the stable semantics projection alongside tags', async () => {
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: PROBLEM_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.tags).toEqual([{ id: 'tag-id', name: 'Algebra' }]);
    expect(body.data.semantics).toMatchObject({
      semantic_revision: 1,
      annotation_status: 'pending',
    });
    expect(mocks.readProblemSemantics).toHaveBeenCalledWith(
      expect.anything(),
      PROBLEM_ID
    );
  });
});

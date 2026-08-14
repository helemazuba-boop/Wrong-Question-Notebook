import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  unauthorised: vi.fn(),
  createServiceClient: vi.fn(),
  readProblemInitialIdeas: vi.fn(),
}));

vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: mocks.unauthorised,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/problem-initial-idea', () => ({
  readProblemInitialIdeas: mocks.readProblemInitialIdeas,
}));

import { GET } from '@/app/api/review-sessions/[sessionId]/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PROBLEM_ID = '44444444-4444-4444-8444-444444444444';

interface QueryResult {
  data: unknown;
  error: unknown;
}

function query(result: QueryResult) {
  const chain: any = {};
  for (const method of ['select', 'eq', 'in', 'order', 'update']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

function supabaseForSession(isReadOnly: boolean) {
  const session = query({
    data: {
      id: SESSION_ID,
      user_id: USER_ID,
      session_state: {
        problem_ids: [PROBLEM_ID],
        current_index: 0,
        completed_problem_ids: [],
        skipped_problem_ids: [],
        initial_statuses: { [PROBLEM_ID]: 'needs_review' },
        elapsed_ms: 0,
        is_read_only: isReadOnly,
      },
    },
    error: null,
  });
  const ownedProblems = query({
    data: [
      {
        id: PROBLEM_ID,
        user_id: isReadOnly ? OWNER_ID : USER_ID,
        title: 'Problem',
        status: 'needs_review',
        problem_tag: [],
      },
    ],
    error: null,
  });
  const results = query({ data: [], error: null });
  const ownerFrom = vi.fn((table: string) => {
    if (table === 'review_session_state') return session;
    if (table === 'problems') return ownedProblems;
    if (table === 'review_session_results') return results;
    throw new Error(`Unexpected table: ${table}`);
  });
  return { ownerSupabase: { from: ownerFrom }, ownedProblems };
}

function getSession(): Promise<Response> {
  return GET(
    new NextRequest(`http://localhost/api/review-sessions/${SESSION_ID}`),
    {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readProblemInitialIdeas.mockResolvedValue(new Map());
});

describe('Review session personal context', () => {
  it('enriches owned sessions with the authenticated owner initial idea', async () => {
    const { ownerSupabase } = supabaseForSession(false);
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: ownerSupabase,
    });
    mocks.readProblemInitialIdeas.mockResolvedValue(
      new Map([
        [
          PROBLEM_ID,
          {
            revision_id: '55555555-5555-4555-8555-555555555555',
            revision: 2,
            revision_kind: 'set',
            idea: 'owner private idea',
          },
        ],
      ])
    );

    const response = await getSession();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.readProblemInitialIdeas).toHaveBeenCalledWith(
      ownerSupabase,
      USER_ID,
      [PROBLEM_ID]
    );
    expect(body.data.problems[0]).toMatchObject({
      initial_idea: 'owner private idea',
      initial_idea_revision: 2,
    });
  });

  it('never reads or serializes the source owner context for a shared read-only session', async () => {
    const { ownerSupabase, ownedProblems } = supabaseForSession(true);
    const serviceSupabase = { from: vi.fn(() => ownedProblems) };
    mocks.requireUser.mockResolvedValue({
      user: { id: USER_ID },
      supabase: ownerSupabase,
    });
    mocks.createServiceClient.mockReturnValue(serviceSupabase);

    const response = await getSession();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(serviceSupabase.from).toHaveBeenCalledWith('problems');
    expect(mocks.readProblemInitialIdeas).not.toHaveBeenCalled();
    expect(body.data.problems[0]).not.toHaveProperty('initial_idea');
    expect(body.data.problems[0]).not.toHaveProperty('initial_idea_revision');
  });
});

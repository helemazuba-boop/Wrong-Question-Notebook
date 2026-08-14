import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  unauthorised: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: mocks.unauthorised,
}));

import { GET } from '@/app/api/problems/[id]/review-scheduler-diagnostics/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROBLEM_ID = '22222222-2222-4222-8222-222222222222';

const diagnostics = {
  version: 1,
  problem_id: PROBLEM_ID,
  authority_mode: 'sm2',
  authority: {
    algorithm: 'sm2',
    next_review_at: '2026-08-10T00:00:00+00:00',
    projection_revision: 2,
  },
  fsrs: {
    algorithm_version: 'FSRS-6.0',
    library_name: 'ts-fsrs',
    library_version: '5.4.1',
    card_initialized: true,
    state: 'Review',
    stability: 4.2,
    difficulty: 5.1,
    scheduled_days: 4,
    reps: 2,
    lapses: 0,
    next_review_at: '2026-08-12T10:00:00+00:00',
    projection_revision: 2,
    parameter_stable_key: 'default-v1',
  },
  projection: {
    status: 'ready',
    dirty_from: null,
    attempt_count: 0,
    last_error_code: null,
    timeline_event_count: 1,
  },
  timeline: [
    {
      review_occurrence_id: '33333333-3333-4333-8333-333333333333',
      event_id: '44444444-4444-4444-8444-444444444444',
      event_kind: 'review',
      human_rating: 'Hard',
      reviewed_at: '2026-08-08T10:00:00+00:00',
      effective_review_at: '2026-08-08T10:00:00+00:00',
      corrected: false,
    },
  ],
};

function callGet(problemId = PROBLEM_ID) {
  return GET(
    new NextRequest(
      `http://localhost/api/problems/${problemId}/review-scheduler-diagnostics`
    ),
    { params: Promise.resolve({ id: problemId }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({
    user: { id: USER_ID },
    supabase: { rpc: mocks.rpc },
  });
  mocks.unauthorised.mockReturnValue(
    Response.json({ error: 'Unauthorized' }, { status: 401 })
  );
  mocks.rpc.mockResolvedValue({ data: diagnostics, error: null });
});

describe('owner scheduler diagnostics route', () => {
  it('reads the owner-safe RPC with the authenticated client', async () => {
    const response = await callGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(diagnostics);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'get_problem_review_scheduler_diagnostics',
      { p_problem_id: PROBLEM_ID }
    );
  });

  it('does not query diagnostics for anonymous users', async () => {
    mocks.requireUser.mockResolvedValue({ user: null, supabase: null });
    const response = await callGet();
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('maps ownership failures to a non-enumerating not-found response', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'PROBLEM_NOT_OWNED' },
    });
    const response = await callGet();
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(
      'Scheduler diagnostics not found'
    );
  });

  it('rejects raw or malformed RPC payloads', async () => {
    mocks.rpc.mockResolvedValue({
      data: { ...diagnostics, card_before: { due: 'secret-internal' } },
      error: null,
    });
    const response = await callGet();
    expect(response.status).toBe(500);
  });
});

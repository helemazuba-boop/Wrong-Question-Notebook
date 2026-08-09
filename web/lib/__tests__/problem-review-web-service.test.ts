import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  correctWebProblemReviewRating,
  recordWebProblemReviewRating,
} from '@/lib/problem-review-service';

vi.mock('@/lib/problem-initial-idea', () => ({
  readProblemInitialIdea: vi.fn().mockResolvedValue({
    revision_id: '77777777-7777-4777-8777-777777777777',
    revision: 1,
    revision_kind: 'set',
    idea: 'human idea',
  }),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROBLEM_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const OCCURRENCE_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const PRIOR_EVENT_ID = '66666666-6666-4666-8666-666666666666';
const INITIAL_IDEA_ID = '77777777-7777-4777-8777-777777777777';
const REVIEWED_AT = '2026-08-09T08:00:00.000Z';

function chain(result: { data: unknown; error: unknown }) {
  const query: any = {};
  for (const method of ['select', 'eq', 'is']) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn().mockResolvedValue(result);
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  return query;
}

function persistedEvent(patch: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    review_occurrence_id: OCCURRENCE_ID,
    problem_id: PROBLEM_ID,
    attempt_id: ATTEMPT_ID,
    event_kind: 'review',
    human_rating: 'Hard',
    channel_source: 'web',
    source_request_id: 'web-review-request-01',
    reviewed_at: REVIEWED_AT,
    effective_review_at: REVIEWED_AT,
    machine_correctness_snapshot: false,
    initial_idea_revision_id: INITIAL_IDEA_ID,
    supersedes_event_id: null,
    ...patch,
  };
}

function rpcResult() {
  return {
    event_id: EVENT_ID,
    review_occurrence_id: OCCURRENCE_ID,
    problem_id: PROBLEM_ID,
    event_kind: 'review',
    human_rating: 'Hard',
    effective_review_at: REVIEWED_AT,
    replayed: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Web human Rating service', () => {
  it('derives machine evidence from the owned Attempt and writes through the privileged client', async () => {
    const ownerFrom = vi.fn((table: string) => {
      if (table === 'problem_review_events') {
        return chain({ data: null, error: null });
      }
      if (table === 'attempts') {
        return chain({
          data: { id: ATTEMPT_ID, problem_id: PROBLEM_ID, is_correct: false },
          error: null,
        });
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const ownerSupabase = { from: ownerFrom } as any;
    const serviceRpc = vi.fn().mockResolvedValue({
      data: rpcResult(),
      error: null,
    });

    const result = await recordWebProblemReviewRating({
      ownerSupabase,
      serviceSupabase: { rpc: serviceRpc } as any,
      userId: USER_ID,
      attemptId: ATTEMPT_ID,
      rating: 'Hard',
      reviewOccurrenceId: OCCURRENCE_ID,
      requestId: 'web-review-request-01',
    });

    expect(result.event_id).toBe(EVENT_ID);
    expect(serviceRpc).toHaveBeenCalledWith(
      'record_problem_review_fact',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_attempt_id: ATTEMPT_ID,
        p_machine_correctness_snapshot: false,
        p_initial_idea_revision_id: INITIAL_IDEA_ID,
        p_channel_source: 'web',
      })
    );
  });

  it('returns an existing matching create request without generating a new server time', async () => {
    const ownerSupabase = {
      from: vi.fn(() => chain({ data: persistedEvent(), error: null })),
    } as any;
    const serviceRpc = vi.fn();

    const result = await recordWebProblemReviewRating({
      ownerSupabase,
      serviceSupabase: { rpc: serviceRpc } as any,
      userId: USER_ID,
      attemptId: ATTEMPT_ID,
      rating: 'Hard',
      reviewOccurrenceId: OCCURRENCE_ID,
      requestId: 'web-review-request-01',
    });

    expect(result).toMatchObject({ event_id: EVENT_ID, replayed: true });
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it('rejects request-id replay when its human Rating payload differs', async () => {
    const ownerSupabase = {
      from: vi.fn(() => chain({ data: persistedEvent(), error: null })),
    } as any;

    await expect(
      recordWebProblemReviewRating({
        ownerSupabase,
        serviceSupabase: { rpc: vi.fn() } as any,
        userId: USER_ID,
        attemptId: ATTEMPT_ID,
        rating: 'Good',
        reviewOccurrenceId: OCCURRENCE_ID,
        requestId: 'web-review-request-01',
      })
    ).rejects.toThrow('REVIEW_REQUEST_ID_REUSED');
  });

  it('replays a matching correction after the superseded event is no longer terminal', async () => {
    const ownerSupabase = {
      from: vi.fn(() =>
        chain({
          data: persistedEvent({ supersedes_event_id: PRIOR_EVENT_ID }),
          error: null,
        })
      ),
    } as any;
    const serviceRpc = vi.fn();

    const result = await correctWebProblemReviewRating({
      ownerSupabase,
      serviceSupabase: { rpc: serviceRpc } as any,
      userId: USER_ID,
      rating: 'Hard',
      reviewOccurrenceId: OCCURRENCE_ID,
      terminalEventId: PRIOR_EVENT_ID,
      requestId: 'web-review-request-01',
    });

    expect(result).toMatchObject({ event_id: EVENT_ID, replayed: true });
    expect(serviceRpc).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { recordProblemReview } from '@/lib/problem-review-service';
import type { ProblemObservationRequest } from '@/lib/problem-study-v1';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '77777777-7777-4777-8777-777777777777';
const PROBLEM_ID = '33333333-3333-4333-8333-333333333333';
const OBS_ID = '44444444-4444-4444-8444-444444444444';

function observationInput(action: string): ProblemObservationRequest {
  return {
    request_id: 'req_problem_observe_01',
    boot_id: 'boot_problem_study_01',
    firmware_version: '0.1.0',
    capabilities: ['problem.study.v1'],
    problem_id: PROBLEM_ID,
    action,
    occurred_at: '2026-07-28T03:20:00.000Z',
  } as ProblemObservationRequest;
}

function correctResult() {
  return {
    observation_id: OBS_ID,
    problem_id: PROBLEM_ID,
    action: 'correct',
    status: 'mastered',
    schedule: {
      next_review_at: '2026-07-31T16:00:00+00:00',
      interval_days: 3,
      ease_factor: 2.6,
      repetition_number: 2,
    },
    projection_applied: true,
    replayed: false,
  };
}

function makeClient(rpcResult: { data: unknown; error: unknown }) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  return { supabase: { rpc } as any, rpc };
}

describe('recordProblemReview', () => {
  it('returns the parsed observation on success', async () => {
    const { supabase, rpc } = makeClient({
      data: correctResult(),
      error: null,
    });
    const result = await recordProblemReview(
      supabase,
      USER_ID,
      DEVICE_ID,
      observationInput('correct')
    );
    expect(result.action).toBe('correct');
    expect(result.status).toBe('mastered');
    expect(result.schedule).toMatchObject({ interval_days: 3 });
    expect(rpc).toHaveBeenCalledWith('record_problem_review_v1', {
      p_user_id: USER_ID,
      p_device_id: DEVICE_ID,
      p_request_id: 'req_problem_observe_01',
      p_problem_id: PROBLEM_ID,
      p_action: 'correct',
      p_occurred_at: '2026-07-28T03:20:00.000Z',
    });
  });

  it('maps a reused request id to a 409', async () => {
    const { supabase } = makeClient({
      data: null,
      error: { message: 'REVIEW_REQUEST_ID_REUSED' },
    });
    await expect(
      recordProblemReview(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('wrong')
      )
    ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED', status: 409 });
  });

  it('maps an invisible problem to 404', async () => {
    const { supabase } = makeClient({
      data: null,
      error: { message: 'REVIEW_PROBLEM_NOT_VISIBLE' },
    });
    await expect(
      recordProblemReview(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('wrong')
      )
    ).rejects.toMatchObject({ code: 'PROBLEM_NOT_VISIBLE', status: 404 });
  });

  it('maps an invalid review to 400', async () => {
    const { supabase } = makeClient({
      data: null,
      error: { message: 'INVALID_PROBLEM_REVIEW' },
    });
    await expect(
      recordProblemReview(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('skip')
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('maps an unknown database failure to a retryable 503', async () => {
    const { supabase } = makeClient({
      data: null,
      error: { message: 'connection reset' },
    });
    await expect(
      recordProblemReview(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('wrong')
      )
    ).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
      status: 503,
      retryable: true,
    });
  });

  it('rejects a malformed RPC result shape', async () => {
    const { supabase } = makeClient({
      data: { observation_id: 'not-a-uuid' },
      error: null,
    });
    await expect(
      recordProblemReview(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('wrong')
      )
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_RESULT', status: 503 });
  });
});

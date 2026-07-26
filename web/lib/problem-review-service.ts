import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger';
import {
  problemObservationDataSchema,
  type ProblemObservationData,
  type ProblemObservationRequest,
} from './problem-study-v1';

// Thin service wrapper around record_problem_review_v1: the RPC owns the
// whole self-assessment chain (attempt insert, problems.status, SM-2
// schedule) in one transaction; this layer maps its errors onto the v3
// envelope vocabulary, mirroring note-study-service.

export class ProblemReviewServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'ProblemReviewServiceError';
  }
}

function mapReviewRpcError(error: { message?: string }): never {
  const message = String(error.message || '');
  if (message.includes('REVIEW_REQUEST_ID_REUSED')) {
    throw new ProblemReviewServiceError(
      'REQUEST_ID_REUSED',
      'Request ID was already used for another review',
      409
    );
  }
  if (message.includes('REVIEW_PROBLEM_NOT_VISIBLE')) {
    throw new ProblemReviewServiceError(
      'PROBLEM_NOT_VISIBLE',
      'Problem is not visible',
      404
    );
  }
  if (message.includes('INVALID_PROBLEM_REVIEW')) {
    throw new ProblemReviewServiceError(
      'INVALID_REQUEST',
      'Invalid problem review observation',
      400
    );
  }
  logger.error('Problem review database operation failed', error, {
    component: 'ProblemStudyV1',
    action: 'recordProblemReview',
  });
  throw new ProblemReviewServiceError(
    'DATABASE_ERROR',
    'Problem review operation failed',
    503,
    true
  );
}

export async function recordProblemReview(
  supabase: SupabaseClient<any>,
  userId: string,
  deviceId: string | null,
  input: ProblemObservationRequest
): Promise<ProblemObservationData> {
  const { data, error } = await supabase.rpc('record_problem_review_v1', {
    p_user_id: userId,
    p_device_id: deviceId,
    p_request_id: input.request_id,
    p_problem_id: input.problem_id,
    p_action: input.action,
    p_occurred_at: input.occurred_at,
  });
  if (error) mapReviewRpcError(error);

  const parsed = problemObservationDataSchema.safeParse(data);
  if (!parsed.success) {
    logger.error(
      'Problem review RPC returned an invalid result',
      parsed.error,
      {
        component: 'ProblemStudyV1',
        action: 'recordProblemReview.parse',
      }
    );
    throw new ProblemReviewServiceError(
      'INVALID_REVIEW_RESULT',
      'Problem review service returned invalid data',
      503,
      true
    );
  }
  return parsed.data;
}

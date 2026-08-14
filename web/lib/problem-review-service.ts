import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from './database.types';
import type { HumanRating } from './fsrs/schemas';
import { logger } from './logger';
import { readProblemInitialIdea } from './problem-initial-idea';
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

const reviewFactResultSchema = z.object({
  event_id: z.uuid(),
  review_occurrence_id: z.uuid(),
  problem_id: z.uuid(),
  event_kind: z.enum(['review', 'skip']),
  human_rating: z.enum(['Again', 'Hard', 'Good', 'Easy']).nullable(),
  effective_review_at: z.iso.datetime({ offset: true }),
  replayed: z.boolean(),
});

const persistedReviewEventSchema = z.object({
  id: z.uuid(),
  review_occurrence_id: z.uuid(),
  problem_id: z.uuid(),
  attempt_id: z.uuid().nullable(),
  event_kind: z.enum(['review', 'skip']),
  human_rating: z.enum(['Again', 'Hard', 'Good', 'Easy']).nullable(),
  channel_source: z.enum(['web', 'device', 'mcp', 'migration']),
  source_request_id: z.string(),
  reviewed_at: z.iso.datetime({ offset: true }),
  effective_review_at: z.iso.datetime({ offset: true }),
  machine_correctness_snapshot: z.boolean().nullable(),
  initial_idea_revision_id: z.uuid().nullable(),
  supersedes_event_id: z.uuid().nullable(),
});

export type ProblemReviewFactResult = z.infer<typeof reviewFactResultSchema>;
type ReviewServiceClient = SupabaseClient<Database>;

function reviewFactResultFromEvent(
  event: z.infer<typeof persistedReviewEventSchema>
): ProblemReviewFactResult {
  return reviewFactResultSchema.parse({
    event_id: event.id,
    review_occurrence_id: event.review_occurrence_id,
    problem_id: event.problem_id,
    event_kind: event.event_kind,
    human_rating: event.human_rating,
    effective_review_at: event.effective_review_at,
    replayed: true,
  });
}

async function loadExistingWebReviewRequest(
  supabase: ReviewServiceClient,
  userId: string,
  requestId: string
) {
  const { data, error } = await supabase
    .from('problem_review_events')
    .select(
      'id, review_occurrence_id, problem_id, attempt_id, event_kind, human_rating, channel_source, source_request_id, reviewed_at, effective_review_at, machine_correctness_snapshot, initial_idea_revision_id, supersedes_event_id'
    )
    .eq('user_id', userId)
    .is('device_id', null)
    .eq('source_request_id', requestId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check Review request replay: ${error.message}`);
  }
  return data ? persistedReviewEventSchema.parse(data) : null;
}

function assertCreateReplayMatches(
  event: z.infer<typeof persistedReviewEventSchema>,
  input: {
    attemptId: string;
    rating: HumanRating;
    reviewOccurrenceId: string;
  }
) {
  if (
    event.channel_source !== 'web' ||
    event.event_kind !== 'review' ||
    event.review_occurrence_id !== input.reviewOccurrenceId ||
    event.attempt_id !== input.attemptId ||
    event.human_rating !== input.rating ||
    event.supersedes_event_id !== null
  ) {
    throw new Error('REVIEW_REQUEST_ID_REUSED');
  }
}

function assertCorrectionReplayMatches(
  event: z.infer<typeof persistedReviewEventSchema>,
  input: {
    rating: HumanRating;
    reviewOccurrenceId: string;
    terminalEventId: string;
  }
) {
  if (
    event.channel_source !== 'web' ||
    event.event_kind !== 'review' ||
    event.review_occurrence_id !== input.reviewOccurrenceId ||
    event.human_rating !== input.rating ||
    event.supersedes_event_id !== input.terminalEventId
  ) {
    throw new Error('REVIEW_REQUEST_ID_REUSED');
  }
}

async function loadOwnedAttempt(
  supabase: ReviewServiceClient,
  userId: string,
  attemptId: string
) {
  const { data, error } = await supabase
    .from('attempts')
    .select('id, problem_id, is_correct')
    .eq('id', attemptId)
    .eq('user_id', userId)
    .single();

  if (error || !data) throw new Error('REVIEW_ATTEMPT_NOT_OWNED');
  return data;
}

export async function recordWebProblemReviewRating(input: {
  ownerSupabase: ReviewServiceClient;
  serviceSupabase: ReviewServiceClient;
  userId: string;
  attemptId: string;
  rating: HumanRating;
  reviewOccurrenceId: string;
  requestId: string;
}): Promise<ProblemReviewFactResult> {
  const existing = await loadExistingWebReviewRequest(
    input.ownerSupabase,
    input.userId,
    input.requestId
  );
  if (existing) {
    assertCreateReplayMatches(existing, input);
    return reviewFactResultFromEvent(existing);
  }

  const attempt = await loadOwnedAttempt(
    input.ownerSupabase,
    input.userId,
    input.attemptId
  );
  const initialIdea = await readProblemInitialIdea(
    input.ownerSupabase,
    input.userId,
    attempt.problem_id
  );
  const reviewedAt = new Date().toISOString();

  const { data, error } = await input.serviceSupabase.rpc(
    'record_problem_review_fact',
    {
      p_event_id: crypto.randomUUID(),
      p_review_occurrence_id: input.reviewOccurrenceId,
      p_user_id: input.userId,
      p_problem_id: attempt.problem_id,
      p_attempt_id: attempt.id,
      p_event_kind: 'review',
      p_human_rating: input.rating,
      p_machine_correctness_snapshot: attempt.is_correct,
      p_channel_source: 'web',
      p_device_id: null,
      p_source_request_id: input.requestId,
      p_reviewed_at: reviewedAt,
      p_initial_idea_revision_id: initialIdea?.revision_id ?? null,
      p_supersedes_event_id: null,
    }
  );

  if (error) {
    if (error.message.includes('REVIEW_REQUEST_ID_REUSED')) {
      const replay = await loadExistingWebReviewRequest(
        input.ownerSupabase,
        input.userId,
        input.requestId
      );
      if (replay) {
        assertCreateReplayMatches(replay, input);
        return reviewFactResultFromEvent(replay);
      }
    }
    throw new Error(`Failed to record Review Rating: ${error.message}`);
  }
  return reviewFactResultSchema.parse(data);
}

export async function correctWebProblemReviewRating(input: {
  ownerSupabase: ReviewServiceClient;
  serviceSupabase: ReviewServiceClient;
  userId: string;
  rating: HumanRating;
  reviewOccurrenceId: string;
  terminalEventId: string;
  requestId: string;
}): Promise<ProblemReviewFactResult> {
  const existing = await loadExistingWebReviewRequest(
    input.ownerSupabase,
    input.userId,
    input.requestId
  );
  if (existing) {
    assertCorrectionReplayMatches(existing, input);
    return reviewFactResultFromEvent(existing);
  }

  const { data: prior, error: priorError } = await input.ownerSupabase
    .from('effective_problem_review_events')
    .select(
      'id, problem_id, attempt_id, reviewed_at, review_occurrence_id, event_kind'
    )
    .eq('id', input.terminalEventId)
    .eq('review_occurrence_id', input.reviewOccurrenceId)
    .eq('user_id', input.userId)
    .eq('event_kind', 'review')
    .single();

  if (
    priorError ||
    !prior ||
    !prior.id ||
    !prior.problem_id ||
    !prior.review_occurrence_id ||
    !prior.reviewed_at
  ) {
    throw new Error('REVIEW_TERMINAL_EVENT_NOT_OWNED');
  }

  const { data, error } = await input.serviceSupabase.rpc(
    'record_problem_review_fact',
    {
      p_event_id: crypto.randomUUID(),
      p_review_occurrence_id: input.reviewOccurrenceId,
      p_user_id: input.userId,
      p_problem_id: prior.problem_id,
      p_attempt_id: prior.attempt_id,
      p_event_kind: 'review',
      p_human_rating: input.rating,
      p_machine_correctness_snapshot: null,
      p_channel_source: 'web',
      p_device_id: null,
      p_source_request_id: input.requestId,
      p_reviewed_at: prior.reviewed_at,
      p_initial_idea_revision_id: null,
      p_supersedes_event_id: prior.id,
    }
  );

  if (error) {
    if (
      error.message.includes('REVIEW_REQUEST_ID_REUSED') ||
      error.message.includes('REVIEW_SUPERSESSION_CONFLICT')
    ) {
      const replay = await loadExistingWebReviewRequest(
        input.ownerSupabase,
        input.userId,
        input.requestId
      );
      if (replay) {
        assertCorrectionReplayMatches(replay, input);
        return reviewFactResultFromEvent(replay);
      }
    }
    throw new Error(`Failed to correct Review Rating: ${error.message}`);
  }
  return reviewFactResultSchema.parse(data);
}

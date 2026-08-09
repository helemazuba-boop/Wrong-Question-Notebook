import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  createEmptyPersistedFsrsCard,
  scheduleFsrsReview,
} from '@/lib/fsrs/scheduler';
import {
  PreparedProjectionSchema,
  ProjectionApplicationSchema,
  ProjectionClaimsSchema,
  ProjectionCommitResultSchema,
  Sm2ProjectionSchema,
  type PreparedProjection,
  type ProjectionApplication,
  type ProjectionClaim,
  type Sm2CompatibilityBaseline,
  type Sm2Projection,
} from '@/lib/fsrs/projector-contract';
import type { HumanRating, PersistedFsrsCard } from '@/lib/fsrs/schemas';
import { SPACED_REPETITION_CONSTANTS } from '@/lib/constants';
import {
  DEFAULT_TIMEZONE,
  isSameDayInTimezone,
  isValidTimezone,
  toDateInTimezone,
  toMidnightUTC,
} from '@/lib/timezone-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  revalidateProblem,
  revalidateUserReviewSchedule,
} from '@/lib/cache-invalidation';

export const PROJECTION_ERROR_CODES = [
  'INVALID_PREPARE_RESULT',
  'INVALID_PARAMETERS',
  'FSRS_CALCULATION_FAILED',
  'SM2_CALCULATION_FAILED',
  'COMMIT_FAILED',
  'PROJECTION_ASSIGNMENT_MISSING',
  'UNKNOWN',
] as const;

export type ProjectionErrorCode = (typeof PROJECTION_ERROR_CODES)[number];

export interface CalculatedProjection {
  applications: ProjectionApplication[];
  fsrsCard: PersistedFsrsCard | null;
  sm2Projection: Sm2Projection | null;
}

export interface ProjectTimelineResult {
  committed: boolean;
  stale: boolean;
  projectionRevision?: number;
}

function addCalendarDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function nextMidnightAfterReview(
  reviewedAt: Date,
  intervalDays: number,
  timezone: string
): Date {
  const date = toDateInTimezone(reviewedAt, timezone);
  const noon = new Date(`${date}T12:00:00Z`);
  return toMidnightUTC(
    addCalendarDays(noon, intervalDays).toISOString().slice(0, 10),
    timezone
  );
}

function sm2Quality(rating: HumanRating): number {
  switch (rating) {
    case 'Again':
      return 1;
    case 'Hard':
      return 3;
    case 'Good':
    case 'Easy':
      return 5;
  }
}

export function replaySm2Compatibility(input: {
  baseline: Sm2CompatibilityBaseline;
  events: PreparedProjection['events'];
}): Sm2Projection | null {
  const events = input.events.filter(
    event => event.event_kind === 'review' && event.include_in_sm2
  );
  if (events.length === 0) return null;

  const timezone = isValidTimezone(input.baseline.timezone)
    ? input.baseline.timezone
    : DEFAULT_TIMEZONE;
  let repetitionNumber = input.baseline.repetition_number;
  let easeFactor = input.baseline.ease_factor;
  let intervalDays = input.baseline.interval_days;
  let lastReviewedAt = input.baseline.last_reviewed_at
    ? new Date(input.baseline.last_reviewed_at)
    : null;
  let nextReviewAt = input.baseline.next_review_at
    ? new Date(input.baseline.next_review_at)
    : null;

  for (const event of events) {
    if (event.human_rating === null) {
      throw new Error('Review Event is missing a human-final Rating');
    }

    const reviewedAt = new Date(event.effective_review_at);
    const sameDay =
      lastReviewedAt !== null &&
      isSameDayInTimezone(lastReviewedAt, reviewedAt, timezone);

    if (!sameDay) {
      const quality = sm2Quality(event.human_rating);
      if (quality >= 3) {
        repetitionNumber += 1;
        if (repetitionNumber === 1) {
          intervalDays = SPACED_REPETITION_CONSTANTS.INITIAL_INTERVALS[0];
        } else if (repetitionNumber === 2) {
          intervalDays = SPACED_REPETITION_CONSTANTS.INITIAL_INTERVALS[1];
        } else {
          intervalDays = Math.round(intervalDays * easeFactor);
        }
        easeFactor = Math.max(
          easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
          SPACED_REPETITION_CONSTANTS.MIN_EASE_FACTOR
        );
      } else {
        repetitionNumber = 0;
        intervalDays = 1;
      }
    }

    nextReviewAt = nextMidnightAfterReview(reviewedAt, intervalDays, timezone);
    lastReviewedAt = reviewedAt;
  }

  if (!lastReviewedAt || !nextReviewAt) return null;
  return Sm2ProjectionSchema.parse({
    next_review_at: nextReviewAt.toISOString(),
    interval_days: intervalDays,
    ease_factor: easeFactor,
    repetition_number: repetitionNumber,
    last_reviewed_at: lastReviewedAt.toISOString(),
  });
}

export function calculatePreparedProjection(
  preparedInput: unknown
): CalculatedProjection {
  const prepared = PreparedProjectionSchema.parse(preparedInput);
  const reviewEvents = prepared.events.filter(
    event => event.event_kind === 'review'
  );
  const applications: ProjectionApplication[] = [];
  let fsrsCard: PersistedFsrsCard | null = null;

  for (const event of reviewEvents) {
    if (
      event.human_rating === null ||
      event.parameter_set_id === null ||
      event.parameters === null
    ) {
      throw new Error('Review Event is missing fact-time scheduler provenance');
    }

    const reviewedAt = new Date(event.effective_review_at);
    const cardBefore = fsrsCard ?? createEmptyPersistedFsrsCard(reviewedAt);
    const result = scheduleFsrsReview({
      card: cardBefore,
      rating: event.human_rating,
      reviewedAt,
      parameters: event.parameters,
    });

    applications.push(
      ProjectionApplicationSchema.parse({
        event_id: event.event_id,
        review_occurrence_id: event.review_occurrence_id,
        parameter_set_id: event.parameter_set_id,
        card_before: cardBefore,
        review_log: result.review_log,
        card_after: result.card,
      })
    );
    fsrsCard = result.card;
  }

  return {
    applications,
    fsrsCard,
    sm2Projection:
      prepared.authority_mode === 'sm2' && prepared.sm2_baseline
        ? replaySm2Compatibility({
            baseline: prepared.sm2_baseline,
            events: prepared.events,
          })
        : null,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'Unknown database error';
}

function classifyProjectionError(error: unknown): ProjectionErrorCode {
  const message = rpcErrorMessage(error);
  if (message.includes('PROJECTION_ASSIGNMENT_MISSING')) {
    return 'PROJECTION_ASSIGNMENT_MISSING';
  }
  if (message.includes('parameter') || message.includes('Parameter')) {
    return 'INVALID_PARAMETERS';
  }
  if (message.includes('SM-2')) return 'SM2_CALCULATION_FAILED';
  if (message.includes('FSRS')) return 'FSRS_CALCULATION_FAILED';
  return 'UNKNOWN';
}

async function failClaim(
  supabase: SupabaseClient<Database>,
  claim: ProjectionClaim,
  code: ProjectionErrorCode
): Promise<void> {
  await supabase.rpc('fail_problem_review_projection_job', {
    p_user_id: claim.user_id,
    p_problem_id: claim.problem_id,
    p_lease_token: claim.lease_token,
    p_error_code: code,
  });
}

export async function claimProjectionJobs(
  supabase: SupabaseClient<Database>,
  limit: number = 10,
  leaseSeconds: number = 120
): Promise<ProjectionClaim[]> {
  const { data, error } = await supabase.rpc(
    'claim_problem_review_projection_jobs',
    {
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    }
  );
  if (error)
    throw new Error(`Failed to claim projection jobs: ${error.message}`);
  return ProjectionClaimsSchema.parse(data);
}

export async function projectClaimedTimeline(
  supabase: SupabaseClient<Database>,
  claimInput: unknown
): Promise<ProjectTimelineResult> {
  const claim = ProjectionClaimsSchema.element.parse(claimInput);
  let prepared: PreparedProjection;

  try {
    const { data, error } = await supabase.rpc(
      'prepare_problem_review_projection',
      {
        p_user_id: claim.user_id,
        p_problem_id: claim.problem_id,
        p_lease_token: claim.lease_token,
      }
    );
    if (error) throw error;
    prepared = PreparedProjectionSchema.parse(data);
  } catch (error) {
    await failClaim(supabase, claim, classifyProjectionError(error));
    throw error;
  }

  let calculated: CalculatedProjection;
  try {
    calculated = calculatePreparedProjection(prepared);
  } catch (error) {
    await failClaim(supabase, claim, classifyProjectionError(error));
    throw error;
  }

  const { data, error } = await supabase.rpc(
    'commit_problem_review_projection',
    {
      p_run_id: prepared.run_id,
      p_lease_token: prepared.lease_token,
      p_expected_event_count: prepared.timeline_event_count,
      p_expected_fingerprint: prepared.timeline_fingerprint,
      p_expected_base_revision: prepared.base_projection_revision,
      p_applications: calculated.applications,
      p_fsrs_card: calculated.fsrsCard,
      p_sm2_projection: calculated.sm2Projection,
    }
  );
  if (error) {
    await failClaim(supabase, claim, 'COMMIT_FAILED');
    throw new Error(`Failed to commit projection: ${error.message}`);
  }

  const committed = ProjectionCommitResultSchema.parse(data);
  if (committed.committed) {
    await Promise.allSettled([
      revalidateProblem(claim.problem_id),
      revalidateUserReviewSchedule(claim.user_id),
    ]);
  }
  return {
    committed: committed.committed,
    stale: committed.stale,
    projectionRevision: committed.projection_revision,
  };
}

export async function runProjectionBatch(input?: {
  limit?: number;
  leaseSeconds?: number;
  concurrency?: number;
}): Promise<{
  claimed: number;
  committed: number;
  stale: number;
  failed: number;
}> {
  const supabase = createServiceClient();
  const claims = await claimProjectionJobs(
    supabase,
    input?.limit ?? 10,
    input?.leaseSeconds ?? 120
  );
  const concurrency = Math.max(1, Math.min(input?.concurrency ?? 3, 5));
  let committed = 0;
  let stale = 0;
  let failed = 0;

  for (let index = 0; index < claims.length; index += concurrency) {
    const batch = claims.slice(index, index + concurrency);
    const results = await Promise.allSettled(
      batch.map(claim => projectClaimedTimeline(supabase, claim))
    );
    for (const result of results) {
      if (result.status === 'rejected') failed += 1;
      else if (result.value.stale) stale += 1;
      else if (result.value.committed) committed += 1;
    }
  }

  return { claimed: claims.length, committed, stale, failed };
}

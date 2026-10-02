import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  WORD_FSRS_MAXIMUM_INTERVAL_DAYS,
  WORD_FSRS_PARAMETERS,
} from '@/lib/fsrs/parameters';
import {
  createEmptyPersistedFsrsCard,
  scheduleFsrsReview,
} from '@/lib/fsrs/scheduler';
import type { HumanRating, PersistedFsrsCard } from '@/lib/fsrs/schemas';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  PreparedWordProjectionSchema,
  WordProjectionClaimsSchema,
  WordProjectionCommitResultSchema,
  type PreparedWordProjection,
  type WordProjectionClaim,
  type WordTimelineEvent,
} from '@/lib/word-progress-projector-contract';

export const WORD_PROJECTION_ERROR_CODES = [
  'INVALID_PREPARE_RESULT',
  'FSRS_CALCULATION_FAILED',
  'COMMIT_FAILED',
  'UNKNOWN',
] as const;

export type WordProjectionErrorCode =
  (typeof WORD_PROJECTION_ERROR_CODES)[number];

export interface WordProjectionResult {
  committed: boolean;
  stale: boolean;
  projectionRevision?: number;
}

export function wordOutcomeRating(outcome: 'known' | 'unknown'): HumanRating {
  return outcome === 'known' ? 'Good' : 'Again';
}

/**
 * The shadow card is a pure function of the word's known/unknown timeline:
 * every run replays the whole timeline from an empty card, so a stale run that
 * commits late cannot smuggle in a different history. The commit RPC refuses
 * the write when the fingerprint moved anyway.
 */
export function calculateWordProjectionCard(
  preparedInput: unknown
): PersistedFsrsCard | null {
  const prepared = PreparedWordProjectionSchema.parse(preparedInput);
  // The persisted timeline is defined as the known/unknown subset, so a skip
  // never reaches this list. Filtering keeps the projector honest if that ever
  // changes: a skip is a fact about the session, not about the schedule.
  const events = prepared.events.filter(
    (event): event is WordTimelineEvent & { outcome: 'known' | 'unknown' } =>
      event.outcome !== 'skip'
  );
  let card: PersistedFsrsCard | null = null;
  let lastReviewedAt: Date | null = null;

  for (const event of events) {
    const reviewedAt = new Date(event.occurred_at);
    lastReviewedAt = reviewedAt;
    card = scheduleFsrsReview({
      card: card ?? createEmptyPersistedFsrsCard(reviewedAt),
      rating: wordOutcomeRating(event.outcome),
      reviewedAt,
      parameters: WORD_FSRS_PARAMETERS,
    }).card;
  }

  // ts-fsrs schedules a maximum_interval card one day beyond the interval it
  // reports (the due date lands on the next day boundary), which would leave
  // interval_days and due_at disagreeing by a day once the RPC caps the column.
  // The product rule is "one year", so the card is pinned to it exactly.
  if (
    card !== null &&
    lastReviewedAt !== null &&
    card.scheduled_days > WORD_FSRS_MAXIMUM_INTERVAL_DAYS
  ) {
    const cappedDue = new Date(lastReviewedAt.getTime());
    cappedDue.setUTCDate(
      cappedDue.getUTCDate() + WORD_FSRS_MAXIMUM_INTERVAL_DAYS
    );
    card = {
      ...card,
      scheduled_days: WORD_FSRS_MAXIMUM_INTERVAL_DAYS,
      due: cappedDue.toISOString(),
    };
  }

  // "unknown" means the user wants the word again right now: the study screen
  // keeps showing it until they get it. FSRS runs here with short term
  // scheduling disabled, so it answers Again with a multi-day interval; the
  // final card is rewritten to an immediate relearning due date. Stability,
  // difficulty and the lapse count still come from FSRS, and the next known
  // review recomputes the schedule from those.
  const last = events.at(-1);
  if (card !== null && last !== undefined && last.outcome === 'unknown') {
    card = {
      ...card,
      state: 'Relearning',
      scheduled_days: 0,
      learning_step_index: 0,
      due: last.occurred_at,
    };
  }

  return card;
}

function rpcErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'Unknown database error';
}

function classifyWordProjectionError(error: unknown): WordProjectionErrorCode {
  const message = rpcErrorMessage(error);
  if (message.includes('FSRS')) return 'FSRS_CALCULATION_FAILED';
  if (message.includes('prepare') || message.includes('Prepare')) {
    return 'INVALID_PREPARE_RESULT';
  }
  return 'UNKNOWN';
}

async function failClaim(
  supabase: SupabaseClient<Database>,
  claim: WordProjectionClaim,
  code: WordProjectionErrorCode
): Promise<void> {
  await supabase.rpc('fail_word_progress_projection_job', {
    p_user_id: claim.user_id,
    p_word_entry_id: claim.word_entry_id,
    p_lease_token: claim.lease_token,
    p_error_code: code,
  });
}

export async function claimWordProjectionJobs(
  supabase: SupabaseClient<Database>,
  limit: number = 10,
  leaseSeconds: number = 120
): Promise<WordProjectionClaim[]> {
  const { data, error } = await supabase.rpc(
    'claim_word_progress_projection_jobs',
    {
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    }
  );
  if (error) {
    throw new Error(`Failed to claim word projection jobs: ${error.message}`);
  }
  return WordProjectionClaimsSchema.parse(data);
}

export async function projectClaimedWordTimeline(
  supabase: SupabaseClient<Database>,
  claimInput: unknown
): Promise<WordProjectionResult> {
  const claim = WordProjectionClaimsSchema.element.parse(claimInput);
  let prepared: PreparedWordProjection;

  try {
    const { data, error } = await supabase.rpc(
      'prepare_word_progress_projection',
      {
        p_user_id: claim.user_id,
        p_word_entry_id: claim.word_entry_id,
        p_lease_token: claim.lease_token,
      }
    );
    if (error) throw error;
    prepared = PreparedWordProjectionSchema.parse(data);
  } catch (error) {
    await failClaim(supabase, claim, classifyWordProjectionError(error));
    throw error;
  }

  let card: PersistedFsrsCard | null;
  try {
    card = calculateWordProjectionCard(prepared);
  } catch (error) {
    await failClaim(supabase, claim, classifyWordProjectionError(error));
    throw error;
  }

  const { data, error } = await supabase.rpc(
    'commit_word_progress_projection',
    {
      p_run_id: prepared.run_id,
      p_lease_token: prepared.lease_token,
      p_expected_event_count: prepared.timeline_event_count,
      p_expected_fingerprint: prepared.timeline_fingerprint,
      p_expected_base_revision: prepared.base_projection_revision,
      p_fsrs_card: card,
    }
  );
  if (error) {
    await failClaim(supabase, claim, 'COMMIT_FAILED');
    throw new Error(`Failed to commit word projection: ${error.message}`);
  }

  const committed = WordProjectionCommitResultSchema.parse(data);
  // Word study reads go straight to the database, so there is no cached word
  // page to invalidate here (unlike the problem projector).
  return {
    committed: committed.committed,
    stale: committed.stale,
    projectionRevision: committed.projection_revision,
  };
}

export async function runWordProjectionBatch(input?: {
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
  const claims = await claimWordProjectionJobs(
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
      batch.map(claim => projectClaimedWordTimeline(supabase, claim))
    );
    for (const result of results) {
      if (result.status === 'rejected') failed += 1;
      else if (result.value.stale) stale += 1;
      else if (result.value.committed) committed += 1;
    }
  }

  return { claimed: claims.length, committed, stale, failed };
}

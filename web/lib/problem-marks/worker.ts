import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  annotateClaimedProblemMark,
  type AnnotateProblemMarkOptions,
  type ProblemMarkAnnotationResult,
} from '@/lib/problem-marks/annotate';
import { claimProblemMarkAnnotations } from '@/lib/problem-marks/lifecycle';
import { createServiceClient } from '@/lib/supabase-utils';

export interface ProblemMarkBatchResult {
  claimed: number;
  resolved: number;
  unresolved: number;
  failed: number;
  skipped: number;
  stoppedEarly: boolean;
}

export interface RunProblemMarkBatchOptions extends AnnotateProblemMarkOptions {
  // Batch shape.
  limit?: number;
  concurrency?: number;
  // Total wall-clock budget for the batch; when exceeded the worker stops
  // claiming new chunks and lets unprocessed claims expire naturally.
  deadlineMs?: number;
  // Injectable for tests; defaults to the service client.
  supabase?: SupabaseClient<Database>;
}

// Bounded batch worker shared by the CRON route and any best-effort wake. It
// claims a batch of pending/failed annotations, then runs each through the
// shared per-claim pipeline under a concurrency cap and a hard deadline.
// Per-claim failures never abort the batch; every claim ends exactly one of
// resolved / unresolved / failed / skipped.
export async function runProblemMarkAnnotationBatch(
  options: RunProblemMarkBatchOptions = {}
): Promise<ProblemMarkBatchResult> {
  const {
    limit = 10,
    concurrency = 2,
    deadlineMs,
    supabase: providedClient,
    leaseSeconds = 180,
    ...annotateOptions
  } = options;

  const supabase = providedClient ?? createServiceClient();
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const boundedConcurrency = Math.max(1, Math.min(concurrency, 5));
  const deadline = deadlineMs ? Date.now() + deadlineMs : null;

  const claims = await claimProblemMarkAnnotations(
    supabase,
    boundedLimit,
    leaseSeconds
  );

  const result: ProblemMarkBatchResult = {
    claimed: claims.length,
    resolved: 0,
    unresolved: 0,
    failed: 0,
    skipped: 0,
    stoppedEarly: false,
  };

  const perClaim: AnnotateProblemMarkOptions = {
    ...annotateOptions,
    leaseSeconds,
  };

  for (let index = 0; index < claims.length; index += boundedConcurrency) {
    if (deadline && Date.now() >= deadline) {
      result.stoppedEarly = true;
      break;
    }
    const chunk = claims.slice(index, index + boundedConcurrency);
    const outcomes = await Promise.allSettled(
      chunk.map(claim => annotateClaimedProblemMark(supabase, claim, perClaim))
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        result.failed += 1;
        continue;
      }
      tally(result, outcome.value);
    }
  }

  return result;
}

function tally(
  result: ProblemMarkBatchResult,
  outcome: ProblemMarkAnnotationResult
): void {
  if (outcome.status === 'resolved') result.resolved += 1;
  else if (outcome.status === 'unresolved') result.unresolved += 1;
  else if (outcome.status === 'failed') result.failed += 1;
  else result.skipped += 1;
}

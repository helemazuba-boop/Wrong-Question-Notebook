import 'server-only';

import { createEmptyCard, fsrs, type FSRS } from 'ts-fsrs';
import {
  toPersistedFsrsCard,
  toPersistedFsrsReviewLog,
  toRuntimeFsrsCard,
  toRuntimeRating,
} from '@/lib/fsrs/conversion';
import {
  FSRS_BASELINE_PARAMETERS,
  toRuntimeFsrsParameters,
} from '@/lib/fsrs/parameters';
import type {
  FsrsParameters,
  HumanRating,
  PersistedFsrsCard,
  PersistedFsrsReviewLog,
} from '@/lib/fsrs/schemas';

export interface FsrsReviewResult {
  card: PersistedFsrsCard;
  review_log: PersistedFsrsReviewLog;
}

export function createFsrsScheduler(
  parameters: FsrsParameters = FSRS_BASELINE_PARAMETERS
): FSRS {
  return fsrs(toRuntimeFsrsParameters(parameters));
}

export function createEmptyPersistedFsrsCard(now: Date): PersistedFsrsCard {
  return toPersistedFsrsCard(createEmptyCard(now));
}

export function scheduleFsrsReview(input: {
  card: PersistedFsrsCard;
  rating: HumanRating;
  reviewedAt: Date;
  parameters?: FsrsParameters;
}): FsrsReviewResult {
  const scheduler = createFsrsScheduler(
    input.parameters ?? FSRS_BASELINE_PARAMETERS
  );
  const result = scheduler.next(
    toRuntimeFsrsCard(input.card),
    input.reviewedAt,
    toRuntimeRating(input.rating)
  );

  return {
    card: toPersistedFsrsCard(result.card),
    review_log: toPersistedFsrsReviewLog(result.log),
  };
}

export function getFsrsRetrievability(input: {
  card: PersistedFsrsCard;
  at: Date;
  parameters?: FsrsParameters;
}): number {
  const scheduler = createFsrsScheduler(
    input.parameters ?? FSRS_BASELINE_PARAMETERS
  );
  return scheduler.get_retrievability(
    toRuntimeFsrsCard(input.card),
    input.at,
    false
  );
}

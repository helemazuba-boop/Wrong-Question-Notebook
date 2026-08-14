/**
 * SM-2 Spaced Repetition Algorithm
 *
 * Pure functions retained for legacy compatibility fixtures. Runtime Review
 * persistence is owned by the immutable Event projector.
 */

import { SPACED_REPETITION_CONSTANTS } from './constants';
import { getLocalMidnightAfterDays, DEFAULT_TIMEZONE } from './timezone-utils';

// =====================================================
// Types
// =====================================================

export interface ReviewInput {
  repetitionNumber: number;
  easeFactor: number;
  intervalDays: number;
  quality: number; // 0-5 SM-2 quality rating
}

export interface ReviewScheduleUpdate {
  repetitionNumber: number;
  easeFactor: number;
  intervalDays: number;
  nextReviewAt: Date;
}

// =====================================================
// Quality Mapping
// =====================================================

/**
 * Maps a three-tier problem status to an SM-2 quality score (0-5).
 *
 *   wrong        → quality 1  (incorrect, reset interval)
 *   needs_review  → quality 3  (correct but shaky, advance slowly)
 *   mastered      → quality 5  (perfect, advance fastest)
 */
export function mapStatusToQuality(
  selectedStatus: 'wrong' | 'needs_review' | 'mastered'
): number {
  switch (selectedStatus) {
    case 'wrong':
      return 1;
    case 'needs_review':
      return 3;
    case 'mastered':
      return 5;
  }
}

// =====================================================
// SM-2 Core Algorithm
// =====================================================

/**
 * Calculates the next review schedule using the SM-2 algorithm.
 *
 * Quality >= 3 (correct): advance repetition, compute new interval
 * Quality < 3 (incorrect): reset repetition to 0, interval to 1
 */
export function calculateNextReview(
  input: ReviewInput,
  userTimezone: string = DEFAULT_TIMEZONE
): ReviewScheduleUpdate {
  const { repetitionNumber, easeFactor, intervalDays, quality } = input;
  const { MIN_EASE_FACTOR, INITIAL_INTERVALS } = SPACED_REPETITION_CONSTANTS;

  let newRep: number;
  let newEF: number;
  let newInterval: number;

  if (quality >= 3) {
    // Correct response
    newRep = repetitionNumber + 1;

    if (newRep === 1) {
      newInterval = INITIAL_INTERVALS[0]; // 1 day
    } else if (newRep === 2) {
      newInterval = INITIAL_INTERVALS[1]; // 3 days
    } else {
      newInterval = Math.round(intervalDays * easeFactor);
    }

    // Adjust ease factor: EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
    newEF = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    newEF = Math.max(newEF, MIN_EASE_FACTOR);
  } else {
    // Incorrect response: reset
    newRep = 0;
    newInterval = 1;
    newEF = easeFactor; // Don't change EF on failure
  }

  // Due date is always the user's local midnight, so all problems due on a
  // given day are available from the start of that day.
  const nextReviewAt = getLocalMidnightAfterDays(newInterval, userTimezone);

  return {
    repetitionNumber: newRep,
    easeFactor: newEF,
    intervalDays: newInterval,
    nextReviewAt,
  };
}

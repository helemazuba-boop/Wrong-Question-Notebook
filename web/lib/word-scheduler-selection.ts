import 'server-only';

import { logger } from '@/lib/logger';

export const WORD_REVIEW_ALGORITHMS = ['sm2', 'fsrs'] as const;

export type WordReviewAlgorithm = (typeof WORD_REVIEW_ALGORITHMS)[number];

// SM-2 is what every deployment shipped before the FSRS word scheduler existed,
// so it is the safe default: an unset, empty, or mistyped variable must never
// move a user onto a scheduler whose shadow cards are not ready.
export const DEFAULT_WORD_REVIEW_ALGORITHM: WordReviewAlgorithm = 'sm2';

export function parseWordReviewAlgorithm(raw: unknown): WordReviewAlgorithm {
  if (typeof raw !== 'string') return DEFAULT_WORD_REVIEW_ALGORITHM;
  return raw.trim().toLowerCase() === 'fsrs' ? 'fsrs' : 'sm2';
}

export function isWordReviewAlgorithm(raw: unknown): boolean {
  return (
    typeof raw === 'string' &&
    (WORD_REVIEW_ALGORITHMS as readonly string[]).includes(
      raw.trim().toLowerCase()
    )
  );
}

/**
 * WORD_REVIEW_ALGORITHM decides where users without a scheduler row start. A
 * per-user row in user_word_scheduler_settings always wins, so changing the
 * variable never moves an existing user between schedulers.
 */
export function getWordReviewAlgorithm(): WordReviewAlgorithm {
  const raw = process.env.WORD_REVIEW_ALGORITHM;
  if (raw !== undefined && raw.trim() !== '' && !isWordReviewAlgorithm(raw)) {
    logger.warn('Unknown WORD_REVIEW_ALGORITHM value; falling back to sm2', {
      component: 'WordSchedulerSelection',
      value: raw,
      allowed: WORD_REVIEW_ALGORITHMS.join(', '),
    });
  }
  return parseWordReviewAlgorithm(raw);
}

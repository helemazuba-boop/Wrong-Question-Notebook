import 'server-only';

import { type Card, type Grade, Rating, type ReviewLog, State } from 'ts-fsrs';
import {
  HumanRatingSchema,
  PersistedFsrsCardSchema,
  PersistedFsrsReviewLogSchema,
  type FsrsStateName,
  type HumanRating,
  type PersistedFsrsCard,
  type PersistedFsrsReviewLog,
} from '@/lib/fsrs/schemas';

const STATE_TO_NAME = {
  [State.New]: 'New',
  [State.Learning]: 'Learning',
  [State.Review]: 'Review',
  [State.Relearning]: 'Relearning',
} as const satisfies Record<State, FsrsStateName>;

const NAME_TO_STATE = {
  New: State.New,
  Learning: State.Learning,
  Review: State.Review,
  Relearning: State.Relearning,
} as const satisfies Record<FsrsStateName, State>;

const RATING_TO_GRADE = {
  Again: Rating.Again,
  Hard: Rating.Hard,
  Good: Rating.Good,
  Easy: Rating.Easy,
} as const satisfies Record<HumanRating, Grade>;

const GRADE_TO_RATING = {
  [Rating.Again]: 'Again',
  [Rating.Hard]: 'Hard',
  [Rating.Good]: 'Good',
  [Rating.Easy]: 'Easy',
} as const satisfies Record<Grade, HumanRating>;

export function toRuntimeRating(value: unknown): Grade {
  return RATING_TO_GRADE[HumanRatingSchema.parse(value)];
}

export function toHumanRating(value: Grade): HumanRating {
  const rating = GRADE_TO_RATING[value];
  if (!rating) {
    throw new Error(`Unsupported FSRS grade: ${String(value)}`);
  }
  return rating;
}

export function toPersistedFsrsCard(card: Card): PersistedFsrsCard {
  return PersistedFsrsCardSchema.parse({
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: card.scheduled_days,
    learning_step_index: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_TO_NAME[card.state],
    last_review: card.last_review?.toISOString() ?? null,
  });
}

export function toRuntimeFsrsCard(value: unknown): Card {
  const card = PersistedFsrsCardSchema.parse(value);
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_step_index,
    reps: card.reps,
    lapses: card.lapses,
    state: NAME_TO_STATE[card.state],
    last_review: card.last_review ? new Date(card.last_review) : undefined,
  };
}

export function toPersistedFsrsReviewLog(
  log: ReviewLog
): PersistedFsrsReviewLog {
  if (log.rating === Rating.Manual) {
    throw new Error('Manual ratings are not human Review facts');
  }

  return PersistedFsrsReviewLogSchema.parse({
    rating: toHumanRating(log.rating),
    state: STATE_TO_NAME[log.state],
    due: log.due.toISOString(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsed_days: log.elapsed_days,
    last_elapsed_days: log.last_elapsed_days,
    scheduled_days: log.scheduled_days,
    learning_step_index: log.learning_steps,
    reviewed_at: log.review.toISOString(),
  });
}

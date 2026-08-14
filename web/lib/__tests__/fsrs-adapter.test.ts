import { createEmptyCard, type Grade, Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import {
  createEmptyPersistedFsrsCard,
  createFsrsScheduler,
  FSRS_ALGORITHM_VERSION,
  FSRS_BASELINE_PARAMETERS,
  FSRS_LIBRARY_VERSION,
  FSRS_RUNTIME_PROVENANCE,
  FsrsParametersSchema,
  getFsrsRetrievability,
  parseFsrsParameters,
  scheduleFsrsReview,
  toPersistedFsrsCard,
  toRuntimeFsrsCard,
} from '@/lib/fsrs';

const FIRST_REVIEW_AT = new Date('2026-01-01T12:00:00.000Z');

describe('WQN FSRS baseline', () => {
  it('pins ts-fsrs 5.4.1, FSRS-6.0, and all 21 baseline weights', () => {
    expect(FSRS_LIBRARY_VERSION).toBe('5.4.1');
    expect(FSRS_ALGORITHM_VERSION).toBe('FSRS-6.0');
    expect(FSRS_RUNTIME_PROVENANCE.runtime_version).toBe(
      'ts-fsrs@5.4.1 using FSRS-6.0'
    );
    expect(FSRS_BASELINE_PARAMETERS).toEqual({
      request_retention: 0.9,
      maximum_interval: 36500,
      w: [
        0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
        0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
        0.0912, 0.0658, 0.1542,
      ],
      enable_fuzz: false,
      enable_short_term: false,
      learning_steps: [],
      relearning_steps: [],
    });
    expect(Object.isFrozen(FSRS_BASELINE_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(FSRS_BASELINE_PARAMETERS.w)).toBe(true);
    expect(Object.isFrozen(FSRS_BASELINE_PARAMETERS.learning_steps)).toBe(true);
    expect(Object.isFrozen(FSRS_BASELINE_PARAMETERS.relearning_steps)).toBe(
      true
    );
  });

  it('rejects non-FSRS-6 parameter sets instead of migrating them silently', () => {
    expect(() =>
      parseFsrsParameters({
        ...FSRS_BASELINE_PARAMETERS,
        w: FSRS_BASELINE_PARAMETERS.w.slice(0, 19),
      })
    ).toThrow();
    expect(() =>
      FsrsParametersSchema.parse({
        ...FSRS_BASELINE_PARAMETERS,
        request_retention: 0,
      })
    ).toThrow();
    expect(() =>
      FsrsParametersSchema.parse({
        ...FSRS_BASELINE_PARAMETERS,
        w: [Number.NaN, ...FSRS_BASELINE_PARAMETERS.w.slice(1)],
      })
    ).toThrow();
  });
});

describe('WQN FSRS Card boundary', () => {
  it('round-trips persisted Cards and renames learning_steps', () => {
    const persisted = createEmptyPersistedFsrsCard(FIRST_REVIEW_AT);
    expect(persisted).toEqual({
      due: '2026-01-01T12:00:00.000Z',
      stability: 0,
      difficulty: 0,
      scheduled_days: 0,
      learning_step_index: 0,
      reps: 0,
      lapses: 0,
      state: 'New',
      last_review: null,
    });

    expect(toPersistedFsrsCard(toRuntimeFsrsCard(persisted))).toEqual(
      persisted
    );
    expect(persisted).not.toHaveProperty('learning_steps');
    expect(persisted).not.toHaveProperty('elapsed_days');
  });

  it('rejects invalid persisted state instead of coercing it', () => {
    const persisted = createEmptyPersistedFsrsCard(FIRST_REVIEW_AT);
    expect(() => toRuntimeFsrsCard({ ...persisted, state: 2 })).toThrow();
    expect(() =>
      toRuntimeFsrsCard({ ...persisted, difficulty: Number.POSITIVE_INFINITY })
    ).toThrow();
  });
});

describe('FSRS-6 golden scheduling', () => {
  it.each([
    {
      rating: 'Again' as const,
      due: '2026-01-02T12:00:00.000Z',
      stability: 0.212,
      difficulty: 6.4133,
      scheduledDays: 1,
    },
    {
      rating: 'Hard' as const,
      due: '2026-01-03T12:00:00.000Z',
      stability: 1.2931,
      difficulty: 5.11217071,
      scheduledDays: 2,
    },
    {
      rating: 'Good' as const,
      due: '2026-01-04T12:00:00.000Z',
      stability: 2.3065,
      difficulty: 2.11810397,
      scheduledDays: 3,
    },
    {
      rating: 'Easy' as const,
      due: '2026-01-09T12:00:00.000Z',
      stability: 8.2956,
      difficulty: 1,
      scheduledDays: 8,
    },
  ])(
    'matches the upstream long-term first $rating result',
    ({ rating, due, stability, difficulty, scheduledDays }) => {
      const result = scheduleFsrsReview({
        card: createEmptyPersistedFsrsCard(FIRST_REVIEW_AT),
        rating,
        reviewedAt: FIRST_REVIEW_AT,
      });

      expect(result.card).toEqual({
        due,
        stability,
        difficulty,
        scheduled_days: scheduledDays,
        learning_step_index: 0,
        reps: 1,
        lapses: 0,
        state: 'Review',
        last_review: '2026-01-01T12:00:00.000Z',
      });
      expect(result.review_log.rating).toBe(rating);
      expect(result.review_log.state).toBe('New');
      expect(result.review_log.reviewed_at).toBe('2026-01-01T12:00:00.000Z');
    }
  );

  it('models a same-day Review instead of discarding it', () => {
    const first = scheduleFsrsReview({
      card: createEmptyPersistedFsrsCard(FIRST_REVIEW_AT),
      rating: 'Good',
      reviewedAt: FIRST_REVIEW_AT,
    });
    const second = scheduleFsrsReview({
      card: first.card,
      rating: 'Hard',
      reviewedAt: new Date('2026-01-01T18:00:00.000Z'),
    });

    expect(second.card).toMatchObject({
      due: '2026-01-03T18:00:00.000Z',
      stability: 2.3065,
      difficulty: 4.75285849,
      scheduled_days: 2,
      reps: 2,
      lapses: 0,
      state: 'Review',
    });
    expect(second.review_log.elapsed_days).toBe(0);
    expect(second.review_log.last_elapsed_days).toBe(0);
  });

  it('does not derive deprecated last_elapsed_days from a previous due date', () => {
    const first = scheduleFsrsReview({
      card: createEmptyPersistedFsrsCard(FIRST_REVIEW_AT),
      rating: 'Good',
      reviewedAt: FIRST_REVIEW_AT,
    });
    const second = scheduleFsrsReview({
      card: first.card,
      rating: 'Good',
      reviewedAt: new Date('2026-01-05T12:00:00.000Z'),
    });

    expect(second.review_log.elapsed_days).toBe(4);
    expect(second.review_log.last_elapsed_days).toBe(0);
  });

  it('matches success, forgetting, and relearning golden states', () => {
    const events = [
      ['2026-01-01T12:00:00.000Z', 'Good'],
      ['2026-01-01T18:00:00.000Z', 'Hard'],
      ['2026-01-05T12:00:00.000Z', 'Good'],
      ['2026-01-20T12:00:00.000Z', 'Again'],
      ['2026-01-21T12:00:00.000Z', 'Good'],
    ] as const;
    const expected = [
      [3, 2.3065, 2.11810397, 1, 0],
      [2, 2.3065, 4.75285849, 2, 0],
      [12, 12.06259485, 4.743334, 3, 0],
      [2, 1.57464055, 8.257398, 4, 1],
      [3, 3.10863915, 8.24436897, 5, 1],
    ] as const;

    let card = createEmptyPersistedFsrsCard(FIRST_REVIEW_AT);
    events.forEach(([reviewedAt, rating], index) => {
      card = scheduleFsrsReview({
        card,
        rating,
        reviewedAt: new Date(reviewedAt),
      }).card;
      expect([
        card.scheduled_days,
        card.stability,
        card.difficulty,
        card.reps,
        card.lapses,
      ]).toEqual(expected[index]);
    });

    expect(
      getFsrsRetrievability({
        card,
        at: new Date(card.due),
      })
    ).toBeCloseTo(0.90242521, 8);
  });

  it('matches single-parameter history rescheduling', () => {
    const scheduler = createFsrsScheduler();
    const ratings: Grade[] = [
      Rating.Good,
      Rating.Hard,
      Rating.Good,
      Rating.Again,
      Rating.Good,
    ];
    const reviewTimes = [
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T18:00:00.000Z',
      '2026-01-05T12:00:00.000Z',
      '2026-01-20T12:00:00.000Z',
      '2026-01-21T12:00:00.000Z',
    ];
    const firstCard = createEmptyCard(FIRST_REVIEW_AT);
    const result = scheduler.reschedule(
      firstCard,
      ratings.map((rating, index) => ({
        rating,
        review: reviewTimes[index],
      })),
      {
        first_card: firstCard,
        now: reviewTimes.at(-1),
        skipManual: true,
        update_memory_state: false,
      }
    );

    expect(
      result.collections.map(item => ({
        due: item.card.due.toISOString(),
        stability: item.card.stability,
        difficulty: item.card.difficulty,
        scheduledDays: item.card.scheduled_days,
      }))
    ).toEqual([
      {
        due: '2026-01-04T12:00:00.000Z',
        stability: 2.3065,
        difficulty: 2.11810397,
        scheduledDays: 3,
      },
      {
        due: '2026-01-03T18:00:00.000Z',
        stability: 2.3065,
        difficulty: 4.75285849,
        scheduledDays: 2,
      },
      {
        due: '2026-01-17T12:00:00.000Z',
        stability: 12.06259485,
        difficulty: 4.743334,
        scheduledDays: 12,
      },
      {
        due: '2026-01-22T12:00:00.000Z',
        stability: 1.57464055,
        difficulty: 8.257398,
        scheduledDays: 2,
      },
      {
        due: '2026-01-24T12:00:00.000Z',
        stability: 3.10863915,
        difficulty: 8.24436897,
        scheduledDays: 3,
      },
    ]);
  });
});

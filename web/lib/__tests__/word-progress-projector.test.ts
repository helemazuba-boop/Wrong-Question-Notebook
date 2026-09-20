import { afterEach, describe, expect, it } from 'vitest';
import {
  WordProjectionClaimSchema,
  PreparedWordProjectionSchema,
} from '@/lib/word-progress-projector-contract';
import {
  WORD_FSRS_MAXIMUM_INTERVAL_DAYS,
  WORD_FSRS_PARAMETERS,
} from '@/lib/fsrs/parameters';
import {
  calculateWordProjectionCard,
  wordOutcomeRating,
} from '@/lib/word-progress-projector';
import {
  getWordReviewAlgorithm,
  parseWordReviewAlgorithm,
} from '@/lib/word-scheduler-selection';

const SEEDED_USER_ID = '00000000-0000-0000-0000-000000000002';
const WORD_ENTRY_ID = 'aa000000-0000-4000-8000-000000000001';
const LEASE_TOKEN = 'bb000000-0000-4000-8000-000000000001';
const RUN_ID = 'cc000000-0000-4000-8000-000000000001';

function timelineEvent(
  outcome: 'known' | 'unknown' | 'skip',
  occurredAt: string,
  index: number
) {
  return {
    event_id: `dd000000-0000-4000-8000-00000000000${index}`,
    outcome,
    occurred_at: occurredAt,
    sequence: index,
  };
}

function prepared(events: ReturnType<typeof timelineEvent>[]) {
  return {
    run_id: RUN_ID,
    user_id: SEEDED_USER_ID,
    word_entry_id: WORD_ENTRY_ID,
    lease_token: LEASE_TOKEN,
    authority_mode: 'sm2' as 'sm2' | 'fsrs',
    base_projection_revision: 0,
    timeline_event_count: events.length,
    timeline_fingerprint: 'a'.repeat(64),
    events,
  };
}

describe('word projection contract', () => {
  it('accepts a seeded user id that is not an RFC 9562 UUID', () => {
    const claim = WordProjectionClaimSchema.parse({
      user_id: SEEDED_USER_ID,
      word_entry_id: WORD_ENTRY_ID,
      dirty_from: '2026-09-01T00:00:00.000Z',
      lease_token: LEASE_TOKEN,
      lease_until: '2026-09-01T00:02:00.000Z',
      attempt_count: 0,
    });

    expect(claim.user_id).toBe(SEEDED_USER_ID);
  });

  it('rejects a claim whose user id is not an id at all', () => {
    const result = WordProjectionClaimSchema.safeParse({
      user_id: 'not-a-user-id',
      word_entry_id: WORD_ENTRY_ID,
      dirty_from: '2026-09-01T00:00:00.000Z',
      lease_token: LEASE_TOKEN,
      lease_until: '2026-09-01T00:02:00.000Z',
      attempt_count: 0,
    });

    expect(result.success).toBe(false);
  });

  it('parses a prepared timeline that carries a seeded user id', () => {
    const parsed = PreparedWordProjectionSchema.parse(
      prepared([timelineEvent('known', '2026-09-01T00:00:00.000Z', 1)])
    );

    expect(parsed.user_id).toBe(SEEDED_USER_ID);
    expect(parsed.events).toHaveLength(1);
  });

  it('rejects a prepared payload that still carries an unused column', () => {
    // The projector is a pure replay of the timeline: it must never read the
    // live word_progress row, so the RPC does not send one. Keeping the schema
    // strict here is what stops that column from creeping back in.
    const result = PreparedWordProjectionSchema.safeParse({
      ...prepared([timelineEvent('known', '2026-09-01T00:00:00.000Z', 1)]),
      progress: null,
    });

    expect(result.success).toBe(false);
  });
});

describe('word FSRS replay', () => {
  it('does not initialize a card from an empty timeline', () => {
    expect(calculateWordProjectionCard(prepared([]))).toBeNull();
  });

  it('does not initialize a card from skips alone', () => {
    const card = calculateWordProjectionCard(
      prepared([
        timelineEvent('skip', '2026-09-01T00:00:00.000Z', 1),
        timelineEvent('skip', '2026-09-02T00:00:00.000Z', 2),
      ])
    );

    expect(card).toBeNull();
  });

  it('maps known to Good and unknown to Again', () => {
    expect(wordOutcomeRating('known')).toBe('Good');
    expect(wordOutcomeRating('unknown')).toBe('Again');
  });

  it('replays the whole timeline deterministically', () => {
    const input = prepared([
      timelineEvent('unknown', '2026-09-01T00:00:00.000Z', 1),
      timelineEvent('known', '2026-09-02T00:00:00.000Z', 2),
      timelineEvent('known', '2026-09-05T00:00:00.000Z', 3),
    ]);

    const first = calculateWordProjectionCard(input);
    const second = calculateWordProjectionCard(input);

    expect(first).toEqual(second);
    expect(first?.reps).toBe(3);
  });

  it('schedules an unknown observation for immediate re-review', () => {
    const card = calculateWordProjectionCard(
      prepared([
        timelineEvent('known', '2026-09-01T00:00:00.000Z', 1),
        timelineEvent('known', '2026-09-04T00:00:00.000Z', 2),
        timelineEvent('unknown', '2026-09-20T00:00:00.000Z', 3),
      ])
    );

    expect(card).toMatchObject({
      state: 'Relearning',
      scheduled_days: 0,
      learning_step_index: 0,
      due: '2026-09-20T00:00:00.000Z',
      lapses: 1,
      reps: 3,
    });
    // Stability and difficulty still come from FSRS, so the next known review
    // continues the real curve instead of restarting from scratch.
    expect(card?.stability).toBeGreaterThan(0);
  });

  it('returns to the FSRS interval after a known review follows the lapse', () => {
    const card = calculateWordProjectionCard(
      prepared([
        timelineEvent('unknown', '2026-09-01T00:00:00.000Z', 1),
        timelineEvent('known', '2026-09-02T00:00:00.000Z', 2),
      ])
    );

    expect(card?.state).not.toBe('Relearning');
    expect(card?.scheduled_days).toBeGreaterThan(0);
    expect(new Date(card?.due ?? 0).getTime()).toBeGreaterThan(
      Date.parse('2026-09-02T00:00:00.000Z')
    );
  });

  it('pins the one year cap exactly, including the due date', () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      timelineEvent(
        'known',
        new Date(Date.UTC(2026, 0, 1 + index * 100)).toISOString(),
        index + 1
      )
    );

    const card = calculateWordProjectionCard(prepared(events));
    const lastReviewedAt = events.at(-1)?.occurred_at ?? '';
    const expectedDue = new Date(lastReviewedAt);
    expectedDue.setUTCDate(
      expectedDue.getUTCDate() + WORD_FSRS_MAXIMUM_INTERVAL_DAYS
    );

    expect(WORD_FSRS_PARAMETERS.maximum_interval).toBe(
      WORD_FSRS_MAXIMUM_INTERVAL_DAYS
    );
    expect(card?.scheduled_days).toBe(WORD_FSRS_MAXIMUM_INTERVAL_DAYS);
    expect(card?.due).toBe(expectedDue.toISOString());
  });
});

describe('word review algorithm selection', () => {
  const original = process.env.WORD_REVIEW_ALGORITHM;

  afterEach(() => {
    if (original === undefined) delete process.env.WORD_REVIEW_ALGORITHM;
    else process.env.WORD_REVIEW_ALGORITHM = original;
  });

  it('defaults to sm2 for missing, empty, or unknown values', () => {
    expect(parseWordReviewAlgorithm(undefined)).toBe('sm2');
    expect(parseWordReviewAlgorithm('')).toBe('sm2');
    expect(parseWordReviewAlgorithm('   ')).toBe('sm2');
    expect(parseWordReviewAlgorithm('sm-2')).toBe('sm2');
    expect(parseWordReviewAlgorithm('bogus')).toBe('sm2');
    expect(parseWordReviewAlgorithm(42)).toBe('sm2');
  });

  it('accepts fsrs regardless of case and padding', () => {
    expect(parseWordReviewAlgorithm('fsrs')).toBe('fsrs');
    expect(parseWordReviewAlgorithm(' FSRS ')).toBe('fsrs');
  });

  it('reads the deployment variable', () => {
    process.env.WORD_REVIEW_ALGORITHM = 'fsrs';
    expect(getWordReviewAlgorithm()).toBe('fsrs');

    process.env.WORD_REVIEW_ALGORITHM = 'nonsense';
    expect(getWordReviewAlgorithm()).toBe('sm2');

    delete process.env.WORD_REVIEW_ALGORITHM;
    expect(getWordReviewAlgorithm()).toBe('sm2');
  });
});

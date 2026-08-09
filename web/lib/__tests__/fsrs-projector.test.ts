import { describe, expect, it } from 'vitest';
import {
  calculatePreparedProjection,
  replaySm2Compatibility,
} from '@/lib/fsrs/projector';
import { FSRS_BASELINE_PARAMETERS } from '@/lib/fsrs/parameters';
import type { PreparedProjectionEvent } from '@/lib/fsrs/projector-contract';

const DEFAULT_PARAMETER_ID = 'f5000000-0000-4000-8000-000000000001';
const SECOND_PARAMETER_ID = 'f5000000-0000-4000-8000-000000000002';

function reviewEvent(input: {
  eventId: string;
  occurrenceId: string;
  rating: 'Again' | 'Hard' | 'Good' | 'Easy';
  reviewedAt: string;
  parameterId?: string;
  includeInSm2?: boolean;
  maximumInterval?: number;
}) {
  return {
    event_id: input.eventId,
    review_occurrence_id: input.occurrenceId,
    event_kind: 'review' as const,
    human_rating: input.rating,
    effective_review_at: input.reviewedAt,
    received_at: input.reviewedAt,
    parameter_set_id: input.parameterId ?? DEFAULT_PARAMETER_ID,
    parameter_stable_key:
      input.parameterId === SECOND_PARAMETER_ID ? 'short-v1' : 'default-v1',
    parameters: {
      ...FSRS_BASELINE_PARAMETERS,
      w: [...FSRS_BASELINE_PARAMETERS.w],
      learning_steps: [...FSRS_BASELINE_PARAMETERS.learning_steps],
      relearning_steps: [...FSRS_BASELINE_PARAMETERS.relearning_steps],
      maximum_interval:
        input.maximumInterval ?? FSRS_BASELINE_PARAMETERS.maximum_interval,
    },
    include_in_sm2: input.includeInSm2 ?? true,
  };
}

function prepared(events: PreparedProjectionEvent[]) {
  return {
    run_id: '77000000-0000-4000-8000-000000000001',
    user_id: '11000000-0000-4000-8000-000000000001',
    problem_id: '33000000-0000-4000-8000-000000000001',
    lease_token: '88000000-0000-4000-8000-000000000001',
    authority_mode: 'sm2' as 'sm2' | 'fsrs',
    base_projection_revision: 0,
    timeline_event_count: events.length,
    timeline_fingerprint: 'a'.repeat(64),
    events,
    sm2_baseline: {
      timezone: 'UTC',
      schedule_existed: false,
      repetition_number: 0,
      ease_factor: 2.5,
      interval_days: 1,
      last_reviewed_at: null,
      next_review_at: null,
    },
  };
}

describe('FSRS durable projector calculation', () => {
  it('replays every human occurrence through next()', () => {
    const result = calculatePreparedProjection(
      prepared([
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000001',
          occurrenceId: '55000000-0000-4000-8000-000000000001',
          rating: 'Hard',
          reviewedAt: '2026-08-01T08:00:00.000Z',
        }),
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000002',
          occurrenceId: '55000000-0000-4000-8000-000000000002',
          rating: 'Good',
          reviewedAt: '2026-08-03T08:00:00.000Z',
        }),
      ])
    );

    expect(result.applications).toHaveLength(2);
    expect(result.applications[0].review_log.rating).toBe('Hard');
    expect(result.applications[1].review_log.rating).toBe('Good');
    expect(result.fsrsCard?.reps).toBe(2);
  });

  it('preserves same-day Review occurrences in the FSRS stream', () => {
    const result = calculatePreparedProjection(
      prepared([
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000003',
          occurrenceId: '55000000-0000-4000-8000-000000000003',
          rating: 'Again',
          reviewedAt: '2026-08-01T08:00:00.000Z',
        }),
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000004',
          occurrenceId: '55000000-0000-4000-8000-000000000004',
          rating: 'Good',
          reviewedAt: '2026-08-01T10:00:00.000Z',
        }),
      ])
    );

    expect(result.applications).toHaveLength(2);
    expect(result.fsrsCard?.reps).toBe(2);
  });

  it('uses each occurrence fact-time parameter assignment', () => {
    const result = calculatePreparedProjection(
      prepared([
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000005',
          occurrenceId: '55000000-0000-4000-8000-000000000005',
          rating: 'Good',
          reviewedAt: '2026-08-01T08:00:00.000Z',
        }),
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000006',
          occurrenceId: '55000000-0000-4000-8000-000000000006',
          rating: 'Easy',
          reviewedAt: '2026-08-04T08:00:00.000Z',
          parameterId: SECOND_PARAMETER_ID,
          maximumInterval: 1,
        }),
      ])
    );

    expect(result.applications.map(item => item.parameter_set_id)).toEqual([
      DEFAULT_PARAMETER_ID,
      SECOND_PARAMETER_ID,
    ]);
    expect(result.applications[1].card_after.due).toBe(
      '2026-08-08T08:00:00.000Z'
    );
  });

  it('does not initialize an FSRS Card from skip alone', () => {
    const input = prepared([]);
    input.timeline_event_count = 1;
    input.events = [
      {
        event_id: '44000000-0000-4000-8000-000000000007',
        review_occurrence_id: '55000000-0000-4000-8000-000000000007',
        event_kind: 'skip',
        human_rating: null,
        effective_review_at: '2026-08-01T08:00:00.000Z',
        received_at: '2026-08-01T08:00:00.000Z',
        parameter_set_id: null,
        parameter_stable_key: null,
        parameters: null,
        include_in_sm2: false,
      },
    ];

    const result = calculatePreparedProjection(input);
    expect(result.applications).toEqual([]);
    expect(result.fsrsCard).toBeNull();
    expect(result.sm2Projection).toBeNull();
  });

  it('maps human Ratings into transitional SM-2 without machine evidence', () => {
    const result = replaySm2Compatibility({
      baseline: prepared([]).sm2_baseline,
      events: [
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000008',
          occurrenceId: '55000000-0000-4000-8000-000000000008',
          rating: 'Again',
          reviewedAt: '2026-08-01T08:00:00.000Z',
        }),
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000009',
          occurrenceId: '55000000-0000-4000-8000-000000000009',
          rating: 'Hard',
          reviewedAt: '2026-08-02T08:00:00.000Z',
        }),
      ],
    });

    expect(result).toMatchObject({
      repetition_number: 1,
      interval_days: 1,
      last_reviewed_at: '2026-08-02T08:00:00.000Z',
    });
  });

  it('keeps the frozen SM-2 same-day compatibility guard deterministic', () => {
    const result = replaySm2Compatibility({
      baseline: {
        ...prepared([]).sm2_baseline,
        repetition_number: 2,
        interval_days: 3,
        last_reviewed_at: '2026-08-01T07:00:00.000Z',
      },
      events: [
        reviewEvent({
          eventId: '44000000-0000-4000-8000-000000000010',
          occurrenceId: '55000000-0000-4000-8000-000000000010',
          rating: 'Again',
          reviewedAt: '2026-08-01T10:00:00.000Z',
        }),
      ],
    });

    expect(result).toMatchObject({ repetition_number: 2, interval_days: 3 });
    expect(result?.next_review_at).toBe('2026-08-04T00:00:00.000Z');
  });

  it('stops transitional SM-2 calculation after FSRS authority cutover', () => {
    const input = prepared([
      reviewEvent({
        eventId: '44000000-0000-4000-8000-000000000011',
        occurrenceId: '55000000-0000-4000-8000-000000000011',
        rating: 'Good',
        reviewedAt: '2026-08-01T08:00:00.000Z',
      }),
    ]);
    input.authority_mode = 'fsrs';

    expect(calculatePreparedProjection(input).sm2Projection).toBeNull();
  });
});

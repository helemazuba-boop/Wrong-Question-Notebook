import 'server-only';

import { z } from 'zod';
import {
  FsrsParametersSchema,
  HumanRatingSchema,
  PersistedFsrsCardSchema,
  PersistedFsrsReviewLogSchema,
} from '@/lib/fsrs/schemas';

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const ProjectionClaimSchema = z
  .object({
    user_id: z.uuid(),
    problem_id: z.uuid(),
    dirty_from: IsoTimestampSchema,
    lease_token: z.uuid(),
    lease_until: IsoTimestampSchema,
    attempt_count: z.number().int().positive(),
  })
  .strict();

export const ProjectionClaimsSchema = z.array(ProjectionClaimSchema);

export const PreparedProjectionEventSchema = z
  .object({
    event_id: z.uuid(),
    review_occurrence_id: z.uuid(),
    event_kind: z.enum(['review', 'skip']),
    human_rating: HumanRatingSchema.nullable(),
    effective_review_at: IsoTimestampSchema,
    received_at: IsoTimestampSchema,
    parameter_set_id: z.uuid().nullable(),
    parameter_stable_key: z.string().min(1).max(64).nullable(),
    parameters: FsrsParametersSchema.nullable(),
    include_in_sm2: z.boolean(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.event_kind === 'review') {
      if (
        event.human_rating === null ||
        event.parameter_set_id === null ||
        event.parameter_stable_key === null ||
        event.parameters === null
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Review Event is missing fact-time scheduler provenance',
        });
      }
    } else if (
      event.human_rating !== null ||
      event.parameter_set_id !== null ||
      event.parameters !== null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Skip Event cannot carry scheduler provenance',
      });
    }
  });

export const Sm2CompatibilityBaselineSchema = z
  .object({
    timezone: z.string().min(1),
    schedule_existed: z.boolean(),
    repetition_number: z.number().int().nonnegative(),
    ease_factor: z.number().finite().min(1),
    interval_days: z.number().int().nonnegative(),
    last_reviewed_at: IsoTimestampSchema.nullable(),
    next_review_at: IsoTimestampSchema.nullable(),
  })
  .strict();

export const PreparedProjectionSchema = z
  .object({
    run_id: z.uuid(),
    user_id: z.uuid(),
    problem_id: z.uuid(),
    lease_token: z.uuid(),
    authority_mode: z.enum(['sm2', 'fsrs']),
    base_projection_revision: z.number().int().nonnegative(),
    timeline_event_count: z.number().int().nonnegative(),
    timeline_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    events: z.array(PreparedProjectionEventSchema),
    sm2_baseline: Sm2CompatibilityBaselineSchema.nullable(),
  })
  .strict();

export const ProjectionApplicationSchema = z
  .object({
    event_id: z.uuid(),
    review_occurrence_id: z.uuid(),
    parameter_set_id: z.uuid(),
    card_before: PersistedFsrsCardSchema,
    review_log: PersistedFsrsReviewLogSchema,
    card_after: PersistedFsrsCardSchema,
  })
  .strict();

export const Sm2ProjectionSchema = z
  .object({
    next_review_at: IsoTimestampSchema,
    interval_days: z.number().int().nonnegative(),
    ease_factor: z.number().finite().min(1),
    repetition_number: z.number().int().nonnegative(),
    last_reviewed_at: IsoTimestampSchema,
  })
  .strict();

export const ProjectionCommitResultSchema = z
  .object({
    committed: z.boolean(),
    stale: z.boolean(),
    projection_revision: z.number().int().positive().optional(),
    authority_mode: z.enum(['sm2', 'fsrs']).optional(),
    next_review_at: IsoTimestampSchema.nullable().optional(),
  })
  .strict();

export type ProjectionClaim = z.infer<typeof ProjectionClaimSchema>;
export type PreparedProjection = z.infer<typeof PreparedProjectionSchema>;
export type PreparedProjectionEvent = z.infer<
  typeof PreparedProjectionEventSchema
>;
export type ProjectionApplication = z.infer<typeof ProjectionApplicationSchema>;
export type Sm2CompatibilityBaseline = z.infer<
  typeof Sm2CompatibilityBaselineSchema
>;
export type Sm2Projection = z.infer<typeof Sm2ProjectionSchema>;

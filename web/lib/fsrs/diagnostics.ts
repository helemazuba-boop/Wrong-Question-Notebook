import { z } from 'zod';
import { HumanRatingSchema } from '@/lib/fsrs/schemas';

const isoTimestampSchema = z.iso.datetime({ offset: true });

const schedulerTimelineEntrySchema = z
  .object({
    review_occurrence_id: z.uuid(),
    event_id: z.uuid(),
    event_kind: z.enum(['review', 'skip']),
    human_rating: HumanRatingSchema.nullable(),
    reviewed_at: isoTimestampSchema,
    effective_review_at: isoTimestampSchema,
    corrected: z.boolean(),
  })
  .strict();

export const ProblemReviewSchedulerDiagnosticsSchema = z
  .object({
    version: z.literal(1),
    problem_id: z.uuid(),
    authority_mode: z.enum(['sm2', 'fsrs']),
    authority: z
      .object({
        algorithm: z.enum(['sm2', 'fsrs']),
        next_review_at: isoTimestampSchema.nullable(),
        projection_revision: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    fsrs: z
      .object({
        algorithm_version: z.literal('FSRS-6.0'),
        library_name: z.literal('ts-fsrs'),
        library_version: z.literal('5.4.1'),
        card_initialized: z.boolean(),
        state: z.enum(['New', 'Learning', 'Review', 'Relearning']).nullable(),
        stability: z.number().finite().nonnegative().nullable(),
        difficulty: z.number().finite().min(0).max(10).nullable(),
        scheduled_days: z.number().int().nonnegative().nullable(),
        reps: z.number().int().nonnegative().nullable(),
        lapses: z.number().int().nonnegative().nullable(),
        next_review_at: isoTimestampSchema.nullable(),
        projection_revision: z.number().int().nonnegative(),
        parameter_stable_key: z.string().min(1).max(64).nullable(),
      })
      .strict()
      .nullable(),
    projection: z
      .object({
        status: z.enum(['ready', 'pending', 'processing', 'retry']),
        dirty_from: isoTimestampSchema.nullable(),
        attempt_count: z.number().int().nonnegative(),
        last_error_code: z.string().min(1).max(64).nullable(),
        timeline_event_count: z.number().int().nonnegative(),
      })
      .strict(),
    timeline: z.array(schedulerTimelineEntrySchema),
  })
  .strict();

export type ProblemReviewSchedulerDiagnostics = z.infer<
  typeof ProblemReviewSchedulerDiagnosticsSchema
>;

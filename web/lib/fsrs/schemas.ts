import { z } from 'zod';

const finiteNumberSchema = z.number().finite();
const FsrsStepSchema = z.custom<`${number}${'m' | 'h' | 'd'}`>(
  value =>
    typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?[mhd]$/.test(value),
  'Expected an FSRS step such as 1m, 2h, or 3d'
);

export const FsrsStateSchema = z.enum([
  'New',
  'Learning',
  'Review',
  'Relearning',
]);

export const HumanRatingSchema = z.enum(['Again', 'Hard', 'Good', 'Easy']);

export const FsrsParametersSchema = z
  .object({
    request_retention: finiteNumberSchema.gt(0).max(1),
    maximum_interval: finiteNumberSchema.int().positive(),
    w: z.array(finiteNumberSchema).length(21),
    enable_fuzz: z.boolean(),
    enable_short_term: z.boolean(),
    learning_steps: z.array(FsrsStepSchema),
    relearning_steps: z.array(FsrsStepSchema),
  })
  .strict();

export const PersistedFsrsCardSchema = z
  .object({
    due: z.iso.datetime({ offset: true }),
    stability: finiteNumberSchema.nonnegative(),
    difficulty: finiteNumberSchema.nonnegative().max(10),
    scheduled_days: finiteNumberSchema.int().nonnegative(),
    learning_step_index: finiteNumberSchema.int().nonnegative(),
    reps: finiteNumberSchema.int().nonnegative(),
    lapses: finiteNumberSchema.int().nonnegative(),
    state: FsrsStateSchema,
    last_review: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const PersistedFsrsReviewLogSchema = z
  .object({
    rating: HumanRatingSchema,
    state: FsrsStateSchema,
    due: z.iso.datetime({ offset: true }),
    stability: finiteNumberSchema.nonnegative(),
    difficulty: finiteNumberSchema.nonnegative().max(10),
    elapsed_days: finiteNumberSchema.int().nonnegative(),
    last_elapsed_days: finiteNumberSchema.int().nonnegative(),
    scheduled_days: finiteNumberSchema.int().nonnegative(),
    learning_step_index: finiteNumberSchema.int().nonnegative(),
    reviewed_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type FsrsStateName = z.infer<typeof FsrsStateSchema>;
export type HumanRating = z.infer<typeof HumanRatingSchema>;
export type FsrsParameters = z.infer<typeof FsrsParametersSchema>;
export type PersistedFsrsCard = z.infer<typeof PersistedFsrsCardSchema>;
export type PersistedFsrsReviewLog = z.infer<
  typeof PersistedFsrsReviewLogSchema
>;

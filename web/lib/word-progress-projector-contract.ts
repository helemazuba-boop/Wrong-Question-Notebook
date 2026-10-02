import { z } from 'zod';

const IsoTimestampSchema = z.iso.datetime({ offset: true });
const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

// Seeded accounts use ids like 00000000-0000-0000-0000-000000000002, whose
// version and variant nibbles are 0, so z.uuid() rejects them and the whole
// claim batch fails to parse. See lib/fsrs/projector-contract.ts, where the
// same mistake kept every problem projection leased forever.
const UserIdSchema = z.guid();

export const WordProjectionClaimSchema = z
  .object({
    user_id: UserIdSchema,
    word_entry_id: z.uuid(),
    dirty_from: IsoTimestampSchema,
    lease_token: z.uuid(),
    lease_until: IsoTimestampSchema,
    attempt_count: z.number().int().nonnegative(),
  })
  .strict();

export const WordProjectionClaimsSchema = z.array(WordProjectionClaimSchema);

export const WordTimelineEventSchema = z
  .object({
    event_id: z.uuid(),
    outcome: z.enum(['known', 'unknown', 'skip']),
    occurred_at: IsoTimestampSchema,
    sequence: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const PreparedWordProjectionSchema = z
  .object({
    run_id: z.uuid(),
    user_id: UserIdSchema,
    word_entry_id: z.uuid(),
    lease_token: z.uuid(),
    authority_mode: z.enum(['sm2', 'fsrs']),
    base_projection_revision: z.number().int().nonnegative(),
    timeline_event_count: z.number().int().nonnegative(),
    timeline_fingerprint: FingerprintSchema,
    events: z.array(WordTimelineEventSchema),
  })
  .strict();

export const WordProjectionCommitResultSchema = z
  .object({
    committed: z.boolean(),
    stale: z.boolean(),
    projection_revision: z.number().int().positive().optional(),
    authority_mode: z.enum(['sm2', 'fsrs']).optional(),
    next_review_at: IsoTimestampSchema.nullable().optional(),
  })
  .strict();

export const WordSchedulerSeedResultSchema = z
  .object({
    inserted: z.number().int().nonnegative(),
    authority_mode: z.enum(['sm2', 'fsrs']),
  })
  .strict();

export type WordProjectionClaim = z.infer<typeof WordProjectionClaimSchema>;
export type PreparedWordProjection = z.infer<
  typeof PreparedWordProjectionSchema
>;
export type WordTimelineEvent = z.infer<typeof WordTimelineEventSchema>;

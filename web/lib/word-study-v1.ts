import { z } from 'zod';
import {
  MAX_SAFE_PROTOCOL_COUNTER,
  requestMetadataSchema,
} from './device-control-v3';

export const WORD_STUDY_CONTRACT = 'word-study-v1' as const;
export const WORD_STUDY_SCHEMA_SHA256 =
  'a7af5dfcc47e6094c2671bf9ea8cf138d68e7c0ffab0bcf91aef3d7225cbbe70' as const;
export const WORD_PACK_SCHEMA_VERSION = 2 as const;
export const WORD_PACK_MAX_BYTES = 4 * 1024 * 1024;
export const WORD_PACK_MAX_ENTRIES = 10_000;
export const WORD_CANDIDATE_PAGE_SIZE = 32;
export const WORD_CANDIDATE_PAGE_LIMIT = 100;

const safeCounterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_SAFE_PROTOCOL_COUNTER);
const uuidSchema = z.uuid();
const seedSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const wordStudyModeSchema = z.enum([
  'sequential',
  'random',
  'dictionary',
]);
export const wordStudyPurposeSchema = z.enum(['study', 'lookup']);
export const wordStudyOrderingSchema = z.enum([
  'sequential',
  'guided_random_v1',
  'lexicographic',
]);
export const wordCandidatePolicyVersionSchema = z.enum([
  'sequential_v1',
  'guided_random_v1',
  'lexicographic_v1',
]);
export const wordObservationActionSchema = z.enum([
  'shown',
  'revealed',
  'known',
  'unknown',
  'skipped',
  'looked_up',
]);

export const wordStudyScopeSchema = z.strictObject({
  deck_ids: z
    .array(uuidSchema)
    .max(32)
    .refine(ids => new Set(ids).size === ids.length),
  include_mastered: z.boolean(),
});

export const wordPackSnapshotSchema = z.strictObject({
  deck_id: uuidSchema,
  content_revision: safeCounterSchema,
  pack_revision: safeCounterSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const createWordStudySessionRequestSchema = requestMetadataSchema.extend(
  {
    domain: z.literal('word'),
    mode: wordStudyModeSchema,
    scope: wordStudyScopeSchema,
    optional_count: z.number().int().min(1).max(500),
    seed: seedSchema.optional(),
  }
);

export const wordStudySessionItemSchema = z.strictObject({
  item_id: uuidSchema,
  deck_id: uuidSchema,
  ordinal: safeCounterSchema,
});

export const wordStudySessionDataSchema = z.strictObject({
  session_id: uuidSchema,
  domain: z.literal('word'),
  mode: wordStudyModeSchema,
  purpose: wordStudyPurposeSchema,
  ordering: wordStudyOrderingSchema,
  candidate_policy_version: wordCandidatePolicyVersionSchema,
  seed: seedSchema,
  scope: wordStudyScopeSchema,
  optional_count: z.number().int().min(1).max(500),
  next_sequence: safeCounterSchema,
  progress_revision: safeCounterSchema,
  snapshot: z.array(wordPackSnapshotSchema).max(32),
  items: z.array(wordStudySessionItemSchema).max(WORD_CANDIDATE_PAGE_LIMIT),
  cursor: z.string().max(256).optional(),
  has_more: z.boolean(),
});

export const wordCandidatePageRequestSchema = requestMetadataSchema.extend({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  limit: z.number().int().min(1).max(WORD_CANDIDATE_PAGE_LIMIT).optional(),
});

export const wordCandidatePageDataSchema = z.strictObject({
  session_id: uuidSchema,
  ordering: wordStudyOrderingSchema,
  candidate_policy_version: wordCandidatePolicyVersionSchema,
  seed: seedSchema,
  snapshot: z.array(wordPackSnapshotSchema).max(32),
  progress_revision: safeCounterSchema,
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  next_cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  items: z.array(wordStudySessionItemSchema).max(WORD_CANDIDATE_PAGE_LIMIT),
  has_more: z.boolean(),
});

export const wordObservationRequestSchema = requestMetadataSchema.extend({
  session_id: uuidSchema,
  sequence: safeCounterSchema,
  item_id: uuidSchema,
  action: wordObservationActionSchema,
  mode: wordStudyModeSchema,
  occurred_at: z.string().datetime(),
});

export const wordProgressProjectionSchema = z
  .strictObject({
    status: z.enum(['new', 'learning', 'review', 'mastered']),
    // PostgreSQL serializes timestamptz values with an explicit UTC offset
    // (for example +00:00). RFC 3339 allows both that form and a trailing Z.
    due_at: z.string().datetime({ offset: true }).nullable(),
    reviewed_count: safeCounterSchema,
    known_count: safeCounterSchema,
    unknown_count: safeCounterSchema,
  })
  .nullable();

export const wordObservationDataSchema = z.strictObject({
  observation_id: uuidSchema,
  session_id: uuidSchema,
  sequence: safeCounterSchema,
  item_id: uuidSchema,
  action: wordObservationActionSchema,
  progress: wordProgressProjectionSchema,
  projection_applied: z.boolean(),
  replayed: z.boolean(),
});

const successEnvelopeSchema = <T extends z.ZodType>(data: T) =>
  z.strictObject({
    ok: z.literal(true),
    request_id: z
      .string()
      .min(16)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    server_time_ms: safeCounterSchema,
    data,
  });

export const createWordStudySessionSuccessSchema = successEnvelopeSchema(
  wordStudySessionDataSchema
);
export const wordCandidatePageSuccessSchema = successEnvelopeSchema(
  wordCandidatePageDataSchema
);
export const wordObservationSuccessSchema = successEnvelopeSchema(
  wordObservationDataSchema
);

export const wordManifestPackSchema = z
  .strictObject({
    pack_id: uuidSchema,
    pack_revision: safeCounterSchema,
    schema_version: z.literal(WORD_PACK_SCHEMA_VERSION),
    format: z.literal('jsonl'),
    // Transport coding of the download body. The stored pack itself stays
    // plain JSONL; the download route deflates it and the device inflates
    // while streaming. Always zlib -- there is no legacy firmware to serve.
    compression: z.literal('zlib'),
    entry_count: z.number().int().min(0).max(WORD_PACK_MAX_ENTRIES),
    byte_size: z.number().int().min(1).max(WORD_PACK_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    download_url: z.string().min(1).max(512),
  })
  .nullable();

export const wordManifestRequestSchema = requestMetadataSchema.extend({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  limit: z.number().int().min(1).max(100).optional(),
});

export const wordManifestDeckSchema = z.strictObject({
  deck_id: uuidSchema,
  title: z.string().min(1).max(80),
  change_sequence: safeCounterSchema,
  content_revision: safeCounterSchema,
  deleted: z.boolean(),
  pack: wordManifestPackSchema,
});

export const wordManifestDataSchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  has_more: z.boolean(),
  decks: z.array(wordManifestDeckSchema).max(100),
});
export const wordManifestSuccessSchema = successEnvelopeSchema(
  wordManifestDataSchema
);

export type WordStudyMode = z.infer<typeof wordStudyModeSchema>;
export type WordStudyPurpose = z.infer<typeof wordStudyPurposeSchema>;
export type WordStudyOrdering = z.infer<typeof wordStudyOrderingSchema>;
export type WordCandidatePolicyVersion = z.infer<
  typeof wordCandidatePolicyVersionSchema
>;
export type WordObservationAction = z.infer<typeof wordObservationActionSchema>;
export type CreateWordStudySessionRequest = z.infer<
  typeof createWordStudySessionRequestSchema
>;
export type WordStudySessionData = z.infer<typeof wordStudySessionDataSchema>;
export type WordCandidatePageRequest = z.infer<
  typeof wordCandidatePageRequestSchema
>;
export type WordCandidatePageData = z.infer<typeof wordCandidatePageDataSchema>;
export type WordObservationRequest = z.infer<
  typeof wordObservationRequestSchema
>;

export function semanticsForWordMode(mode: WordStudyMode): {
  purpose: WordStudyPurpose;
  ordering: WordStudyOrdering;
} {
  switch (mode) {
    case 'random':
      return { purpose: 'study', ordering: 'guided_random_v1' };
    case 'dictionary':
      return { purpose: 'lookup', ordering: 'lexicographic' };
    case 'sequential':
      return { purpose: 'study', ordering: 'sequential' };
  }
}

export function candidatePolicyVersionForOrdering(
  ordering: WordStudyOrdering
): WordCandidatePolicyVersion {
  switch (ordering) {
    case 'guided_random_v1':
      return 'guided_random_v1';
    case 'lexicographic':
      return 'lexicographic_v1';
    case 'sequential':
      return 'sequential_v1';
  }
}

export function observationMutatesProgress(
  action: WordObservationAction
): boolean {
  return action === 'known' || action === 'unknown';
}

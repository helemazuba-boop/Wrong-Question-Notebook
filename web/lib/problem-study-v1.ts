import { z } from 'zod';
import { requestMetadataSchema } from './device-control-v3';
import { PROBLEM_TYPE_VALUES } from './schemas';

// Problem Study v1: device-side problem review over problem-set packs.
//
// "错题本" on the device is a problem_set (user-curated, manual or smart);
// one set = one deterministic JSONL pack mirroring the note-study wire model
// (offset-relisted manifest, zlib transport, sha256 over the plain body).
// There is no session runtime: packs are reviewed in fixed order and each
// verdict is a standalone idempotent observation (correct/hesitant/wrong/
// skip) applied by record_problem_review_v1.

export const PROBLEM_STUDY_CONTRACT = 'problem-study-v1' as const;
export const PROBLEM_STUDY_SCHEMA_SHA256 =
  'c99894a28b3aa5da2cab05b17ba7b90a782430dd30627bca7e1a00c9c29aea3d' as const;
export const PROBLEM_PACK_SCHEMA_VERSION = 1 as const;
export const PROBLEM_PACK_MAX_BYTES = 4 * 1024 * 1024;
export const PROBLEM_PACK_MAX_ENTRIES = 500;

const uuidSchema = z.uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const safeCounterSchema = z.number().int().nonnegative();

export const problemReviewActionSchema = z.enum([
  'correct',
  'hesitant',
  'wrong',
  'skip',
]);

// Pack JSONL rows (validated in tests/fixtures; the device parses the same
// shape). Every key is always present so the row layout stays uniform:
// unset full_marks is 0, unset text fields are ''.
export const problemPackPartSchema = z.strictObject({
  index: z.number().int().min(1).max(10),
  label: z.string().max(20),
  type: z.enum(PROBLEM_TYPE_VALUES),
  full_marks: z.number().int().min(0).max(200),
  content_text: z.string(),
  // Display-ready answer line (choice letters joined for MCQ parts); the
  // device never parses answer_config.
  answer_text: z.string(),
});

export const problemPackRowSchema = z.strictObject({
  problem_id: uuidSchema,
  title: z.string().min(1).max(200),
  content_text: z.string(),
  parts: z.array(problemPackPartSchema).min(1).max(10),
  source: z.record(z.string(), z.unknown()),
  status: z.enum(['wrong', 'needs_review', 'mastered']),
  is_optional: z.boolean(),
  image_ids: z.array(sha256Schema).max(8),
  solution_image_ids: z.array(sha256Schema).max(8),
});

export const problemPackMetaSchema = z.strictObject({
  v: z.literal(PROBLEM_PACK_SCHEMA_VERSION),
  problem_set_id: uuidSchema,
  pack_revision: safeCounterSchema,
  count: z.number().int().min(0).max(PROBLEM_PACK_MAX_ENTRIES),
});

// Manifest -------------------------------------------------------------------

export const problemManifestRequestSchema = requestMetadataSchema.extend({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  limit: z.number().int().min(1).max(100).optional(),
});

export const problemManifestPackSchema = z
  .strictObject({
    pack_id: uuidSchema,
    pack_revision: safeCounterSchema,
    schema_version: z.literal(PROBLEM_PACK_SCHEMA_VERSION),
    format: z.literal('jsonl'),
    // Transport coding of the download body (see note-study-v1): always zlib.
    compression: z.literal('zlib'),
    entry_count: z.number().int().min(0).max(PROBLEM_PACK_MAX_ENTRIES),
    byte_size: z.number().int().min(1).max(PROBLEM_PACK_MAX_BYTES),
    sha256: sha256Schema,
    download_url: z.string().min(1).max(512),
  })
  .nullable();

export const problemManifestSetSchema = z.strictObject({
  problem_set_id: uuidSchema,
  name: z.string().min(1).max(200),
  is_smart: z.boolean(),
  deleted: z.boolean(),
  pack: problemManifestPackSchema,
});

export const problemManifestDataSchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  has_more: z.boolean(),
  problem_sets: z.array(problemManifestSetSchema).max(100),
});

// Observation ----------------------------------------------------------------

export const problemObservationRequestSchema = requestMetadataSchema.extend({
  problem_id: uuidSchema,
  action: problemReviewActionSchema,
  occurred_at: z.string().datetime(),
});

export const problemScheduleProjectionSchema = z
  .strictObject({
    next_review_at: z.string().datetime({ offset: true }),
    interval_days: z.number().int().min(0),
    ease_factor: z.number().min(1),
    repetition_number: z.number().int().min(0),
  })
  .nullable();

export const problemObservationDataSchema = z.strictObject({
  observation_id: uuidSchema,
  problem_id: uuidSchema,
  action: problemReviewActionSchema,
  status: z.enum(['wrong', 'needs_review', 'mastered']),
  schedule: problemScheduleProjectionSchema,
  projection_applied: z.boolean(),
  replayed: z.boolean(),
});

// Envelope -------------------------------------------------------------------

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

export const problemManifestSuccessSchema = successEnvelopeSchema(
  problemManifestDataSchema
);
export const problemObservationSuccessSchema = successEnvelopeSchema(
  problemObservationDataSchema
);

export type ProblemReviewAction = z.infer<typeof problemReviewActionSchema>;
export type ProblemPackPart = z.infer<typeof problemPackPartSchema>;
export type ProblemPackRow = z.infer<typeof problemPackRowSchema>;
export type ProblemManifestData = z.infer<typeof problemManifestDataSchema>;
export type ProblemObservationRequest = z.infer<
  typeof problemObservationRequestSchema
>;
export type ProblemObservationData = z.infer<
  typeof problemObservationDataSchema
>;

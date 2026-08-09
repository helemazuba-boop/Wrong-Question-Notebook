import { z } from 'zod';
import {
  MAX_SAFE_PROTOCOL_COUNTER,
  requestMetadataSchema,
} from './device-control-v3';

// Note Study v1 mirrors the word-study wire model but for the blank-notebook
// domain: browse-only purpose, read-state projection only (never mastery), and
// `opened` as the single explicit durable observation (see the contract README
// gate-0 lock). It reuses the shared study-session runtime primitives.

export const NOTE_STUDY_CONTRACT = 'note-study-v1' as const;
export const NOTE_STUDY_SCHEMA_SHA256 =
  '78e0cc0788e6c9d470e103b848652a3d81c625030069ffa578a89f6f0036b351' as const;
export const NOTE_PACK_SCHEMA_VERSION = 1 as const;
export const NOTE_PACK_MAX_BYTES = 4 * 1024 * 1024;
export const NOTE_PACK_MAX_ENTRIES = 5_000;
export const NOTE_CANDIDATE_PAGE_SIZE = 32;
export const NOTE_CANDIDATE_PAGE_LIMIT = 100;

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

export const noteStudyModeSchema = z.enum(['sequential', 'recent']);
export const noteStudyPurposeSchema = z.enum(['browse']);
export const noteStudyOrderingSchema = z.enum([
  'sequential_note_v1',
  'least_recently_viewed_v1',
]);
export const noteCandidatePolicyVersionSchema = z.enum([
  'sequential_note_v1',
  'least_recently_viewed_v1',
]);
export const noteObservationActionSchema = z.enum([
  'opened',
  'read_completed',
  'skipped',
  'session_paused',
]);

export const noteStudyScopeSchema = z.strictObject({
  notebook_ids: z
    .array(uuidSchema)
    .max(32)
    .refine(ids => new Set(ids).size === ids.length),
  include_archived: z.boolean(),
});

export const notePackSnapshotSchema = z.strictObject({
  notebook_id: uuidSchema,
  content_revision: safeCounterSchema,
  pack_revision: safeCounterSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const createNoteStudySessionRequestSchema = requestMetadataSchema.extend(
  {
    domain: z.literal('note'),
    mode: noteStudyModeSchema,
    scope: noteStudyScopeSchema,
    optional_count: z.number().int().min(1).max(500).optional(),
    seed: seedSchema.optional(),
  }
);

export const noteStudySessionItemSchema = z.strictObject({
  item_id: uuidSchema,
  notebook_id: uuidSchema,
  ordinal: safeCounterSchema,
  // Read-state pin as of session creation: drives the device last-viewed label.
  last_opened_at: z.string().datetime({ offset: true }).nullable().optional(),
});

export const noteStudySessionDataSchema = z.strictObject({
  session_id: uuidSchema,
  domain: z.literal('note'),
  mode: noteStudyModeSchema,
  purpose: noteStudyPurposeSchema,
  ordering: noteStudyOrderingSchema,
  candidate_policy_version: noteCandidatePolicyVersionSchema,
  seed: seedSchema,
  scope: noteStudyScopeSchema,
  optional_count: z.number().int().min(1).max(500).optional(),
  next_sequence: safeCounterSchema,
  progress_revision: safeCounterSchema,
  snapshot: z.array(notePackSnapshotSchema).max(32),
  items: z.array(noteStudySessionItemSchema).max(NOTE_CANDIDATE_PAGE_LIMIT),
  cursor: z.string().max(256).optional(),
  has_more: z.boolean(),
});

export const noteCandidatePageRequestSchema = requestMetadataSchema.extend({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  limit: z.number().int().min(1).max(NOTE_CANDIDATE_PAGE_LIMIT).optional(),
});

export const noteCandidatePageDataSchema = z.strictObject({
  session_id: uuidSchema,
  ordering: noteStudyOrderingSchema,
  candidate_policy_version: noteCandidatePolicyVersionSchema,
  seed: seedSchema,
  snapshot: z.array(notePackSnapshotSchema).max(32),
  progress_revision: safeCounterSchema,
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  next_cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  items: z.array(noteStudySessionItemSchema).max(NOTE_CANDIDATE_PAGE_LIMIT),
  has_more: z.boolean(),
});

export const noteObservationRequestSchema = requestMetadataSchema.extend({
  session_id: uuidSchema,
  sequence: safeCounterSchema,
  item_id: uuidSchema,
  action: noteObservationActionSchema,
  mode: noteStudyModeSchema,
  occurred_at: z.string().datetime(),
});

export const noteProgressProjectionSchema = z
  .strictObject({
    // read-state only: never mastery / known-unknown / schedule.
    last_opened_at: z.string().datetime({ offset: true }).nullable(),
    last_completed_at: z.string().datetime({ offset: true }).nullable(),
    completed_count: safeCounterSchema,
  })
  .nullable();

export const noteObservationDataSchema = z.strictObject({
  observation_id: uuidSchema,
  session_id: uuidSchema,
  sequence: safeCounterSchema,
  item_id: uuidSchema,
  action: noteObservationActionSchema,
  progress: noteProgressProjectionSchema,
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

export const createNoteStudySessionSuccessSchema = successEnvelopeSchema(
  noteStudySessionDataSchema
);
export const noteCandidatePageSuccessSchema = successEnvelopeSchema(
  noteCandidatePageDataSchema
);
export const noteObservationSuccessSchema = successEnvelopeSchema(
  noteObservationDataSchema
);

export const noteManifestPackSchema = z
  .strictObject({
    pack_id: uuidSchema,
    pack_revision: safeCounterSchema,
    schema_version: z.literal(NOTE_PACK_SCHEMA_VERSION),
    format: z.literal('jsonl'),
    // Transport coding of the download body (see word-study-v1): always zlib.
    compression: z.literal('zlib'),
    entry_count: z.number().int().min(0).max(NOTE_PACK_MAX_ENTRIES),
    byte_size: z.number().int().min(1).max(NOTE_PACK_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    download_url: z.string().min(1).max(512),
  })
  .nullable();

export const noteManifestRequestSchema = requestMetadataSchema.extend({
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  limit: z.number().int().min(1).max(100).optional(),
  snapshot_id: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const noteManifestNotebookSchema = z.strictObject({
  notebook_id: uuidSchema,
  title: z.string().min(1).max(80),
  change_sequence: safeCounterSchema,
  content_revision: safeCounterSchema,
  deleted: z.boolean(),
  pack: noteManifestPackSchema,
});

export const noteManifestDataSchema = z.strictObject({
  revision: safeCounterSchema.optional(),
  snapshot_id: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  has_more: z.boolean(),
  notebooks: z.array(noteManifestNotebookSchema).max(100),
});
export const noteManifestSuccessSchema = successEnvelopeSchema(
  noteManifestDataSchema
);

export type NoteStudyMode = z.infer<typeof noteStudyModeSchema>;
export type NoteStudyPurpose = z.infer<typeof noteStudyPurposeSchema>;
export type NoteStudyOrdering = z.infer<typeof noteStudyOrderingSchema>;
export type NoteCandidatePolicyVersion = z.infer<
  typeof noteCandidatePolicyVersionSchema
>;
export type NoteObservationAction = z.infer<typeof noteObservationActionSchema>;
export type CreateNoteStudySessionRequest = z.infer<
  typeof createNoteStudySessionRequestSchema
>;
export type NoteStudySessionData = z.infer<typeof noteStudySessionDataSchema>;
export type NoteCandidatePageRequest = z.infer<
  typeof noteCandidatePageRequestSchema
>;
export type NoteCandidatePageData = z.infer<typeof noteCandidatePageDataSchema>;
export type NoteObservationRequest = z.infer<
  typeof noteObservationRequestSchema
>;

export function semanticsForNoteMode(mode: NoteStudyMode): {
  purpose: NoteStudyPurpose;
  ordering: NoteStudyOrdering;
} {
  switch (mode) {
    case 'recent':
      return { purpose: 'browse', ordering: 'least_recently_viewed_v1' };
    case 'sequential':
      return { purpose: 'browse', ordering: 'sequential_note_v1' };
  }
}

export function candidatePolicyVersionForOrdering(
  ordering: NoteStudyOrdering
): NoteCandidatePolicyVersion {
  switch (ordering) {
    case 'least_recently_viewed_v1':
      return 'least_recently_viewed_v1';
    case 'sequential_note_v1':
      return 'sequential_note_v1';
  }
}

// Only opened/read_completed touch the read-state projection; skipped and
// session_paused are append-only history that advance the sequence.
export function observationMutatesProgress(
  action: NoteObservationAction
): boolean {
  return action === 'opened' || action === 'read_completed';
}

import { z } from 'zod';
import { requestMetadataSchema } from './device-control-v3';
import { outboxReceiptDataSchema } from './outbox-reconciliation-v1';
import {
  wordStudyModeSchema,
  wordStudyPurposeSchema,
  wordStudyOrderingSchema,
} from './word-study-v1';
import { noteStudyModeSchema, noteStudyOrderingSchema } from './note-study-v1';

export const OUTBOX_RECOVERY_CONTEXT_CONTRACT =
  'outbox-recovery-context-v1' as const;
export const OUTBOX_RECOVERY_CONTEXT_MAX_REQUEST_BYTES = 4 * 1024;
export const OUTBOX_RECOVERY_CONTEXT_MAX_RESPONSE_BYTES = 12 * 1024;
export const OUTBOX_RECOVERY_CONTEXT_TIMEOUT_MS = 5000;
export const OUTBOX_RECOVERY_CONTEXT_SOURCE_HEADER = 'X-WQN-Source-Mac';
export const OUTBOX_RECOVERY_CONTEXT_ACK_HEADER = 'X-WQN-Context-Source-Mac';
export const OUTBOX_RECOVERY_CONTEXT_PIN_PAGE = 8;
export const OUTBOX_RECOVERY_CONTEXT_CANDIDATE_PAGE = 32;
export const OUTBOX_RECOVERY_CONTEXT_RECEIPT_PAGE = 16;

export const recoveryUuidSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().max(64).datetime({ offset: true });
const requestId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const ids = z
  .array(recoveryUuidSchema)
  .max(32)
  .refine(a => new Set(a.map(s => s.toLowerCase())).size === a.length);
const requestFields = {
  contract: z.literal(OUTBOX_RECOVERY_CONTEXT_CONTRACT),
  domain: z.enum(['word', 'note']),
  session_id: recoveryUuidSchema,
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  manifest_sha256: sha,
  elf_sha256: sha,
};
export const outboxRecoveryContextRequestSchema = z.discriminatedUnion('part', [
  requestMetadataSchema.extend({
    ...requestFields,
    part: z.literal('session'),
    offset: z.literal(0),
    expected_context_sha256: sha.nullable(),
  }),
  requestMetadataSchema.extend({
    ...requestFields,
    part: z.literal('pins'),
    offset: z.number().int().min(0).max(32),
    expected_context_sha256: sha,
  }),
  requestMetadataSchema.extend({
    ...requestFields,
    part: z.literal('candidates'),
    offset: z.number().int().min(0).max(500),
    expected_context_sha256: sha,
  }),
  requestMetadataSchema.extend({
    ...requestFields,
    part: z.literal('receipts'),
    offset: z.literal(0),
    expected_context_sha256: sha,
    request_ids: z
      .array(requestId)
      .min(1)
      .max(OUTBOX_RECOVERY_CONTEXT_RECEIPT_PAGE)
      .refine(values => new Set(values).size === values.length),
  }),
]);
const sessionCommon = {
  session_id: recoveryUuidSchema,
  optional_count: z.number().int().min(1).max(500).nullable(),
  seed: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  progress_revision: counter,
  next_sequence: counter,
  candidate_count: z.number().int().min(0).max(500),
  snapshot_count: z.number().int().min(0).max(32),
  cursor: z.string().max(256).nullable(),
  has_more: z.boolean(),
  status: z.enum(['active', 'paused', 'completed', 'abandoned']),
  started_at: timestamp,
  ended_at: timestamp.nullable(),
  expires_at: timestamp,
  create_request_id: requestId,
  create_fingerprint: sha,
  local_session: z.boolean(),
  local_start_index: z.number().int().min(0).max(10000).nullable(),
  local_fingerprint: sha.nullable(),
};
const session = z.discriminatedUnion('domain', [
  z.strictObject({
    ...sessionCommon,
    domain: z.literal('word'),
    mode: wordStudyModeSchema,
    purpose: wordStudyPurposeSchema,
    ordering: wordStudyOrderingSchema,
    scope: z.strictObject({ deck_ids: ids, include_mastered: z.boolean() }),
  }),
  z.strictObject({
    ...sessionCommon,
    domain: z.literal('note'),
    mode: noteStudyModeSchema,
    purpose: z.literal('browse'),
    ordering: noteStudyOrderingSchema,
    scope: z.strictObject({ notebook_ids: ids, include_archived: z.boolean() }),
  }),
]);
const pinCommon = {
  content_revision: counter,
  pack_revision: counter,
  sha256: sha,
};
const wordRecord = z.strictObject({
  pack_id: recoveryUuidSchema,
  pack_revision: counter.min(1),
  sha256: sha,
  schema_version: z.literal(2),
  format: z.literal('jsonl'),
  compression: z.literal('none'),
  entry_count: z.number().int().min(0).max(10000),
  byte_size: z
    .number()
    .int()
    .min(0)
    .max(4 * 1024 * 1024),
  created_at: timestamp,
});
const noteRecord = z.strictObject({
  logical_id: recoveryUuidSchema,
  revision: counter,
  sha256: sha,
  byte_size: z
    .number()
    .int()
    .min(0)
    .max(4 * 1024 * 1024),
  created_at: timestamp,
});
const wordRegistry = z.discriminatedUnion('state', [
  z.strictObject({
    kind: z.literal('word_ready_registry'),
    state: z.literal('missing'),
    record: z.null(),
  }),
  z.strictObject({
    kind: z.literal('word_ready_registry'),
    state: z.enum(['ready', 'stale', 'failed']),
    record: wordRecord,
  }),
]);
const noteRegistry = z.discriminatedUnion('state', [
  z.strictObject({
    kind: z.literal('note_artifact_registry'),
    state: z.literal('missing'),
    record: z.null(),
  }),
  z.strictObject({
    kind: z.literal('note_artifact_registry'),
    state: z.literal('found'),
    record: noteRecord,
  }),
]);
const pin = z.union([
  z.strictObject({
    index: z.number().int().min(0).max(31),
    pin: z.strictObject({
      ...pinCommon,
      deck_id: recoveryUuidSchema,
      pack_revision: counter.min(1),
    }),
    registry: wordRegistry,
  }),
  z.strictObject({
    index: z.number().int().min(0).max(31),
    pin: z.strictObject({ ...pinCommon, notebook_id: recoveryUuidSchema }),
    registry: noteRegistry,
  }),
]);
const candidate = z.union([
  z.strictObject({
    index: z.number().int().min(0).max(499),
    item: z.strictObject({
      item_id: recoveryUuidSchema,
      deck_id: recoveryUuidSchema,
      ordinal: counter,
    }),
  }),
  z.strictObject({
    index: z.number().int().min(0).max(499),
    item: z.strictObject({
      item_id: recoveryUuidSchema,
      notebook_id: recoveryUuidSchema,
      ordinal: counter,
      last_opened_at: timestamp.nullable().optional(),
    }),
  }),
]);
const common = {
  contract: z.literal(OUTBOX_RECOVERY_CONTEXT_CONTRACT),
  read_at: timestamp,
  context_sha256: sha,
  actor: z.strictObject({
    user_id: recoveryUuidSchema,
    device_id: recoveryUuidSchema,
  }),
  binding: z.strictObject({
    source_mac: z.string().regex(/^[0-9a-f]{12}$/),
    nonce: requestFields.nonce,
    manifest_sha256: sha,
    elf_sha256: sha,
  }),
  session_id: recoveryUuidSchema,
  domain: requestFields.domain,
  repair_authorized: z.literal(false),
};
export const outboxRecoveryContextDataSchema = z.discriminatedUnion('part', [
  z.strictObject({
    ...common,
    part: z.literal('session'),
    offset: z.literal(0),
    total_count: z.literal(1),
    next_offset: z.literal(1),
    has_more: z.literal(false),
    session,
  }),
  z.strictObject({
    ...common,
    part: z.literal('pins'),
    offset: z.number().int().min(0).max(32),
    total_count: z.number().int().min(0).max(32),
    next_offset: z.number().int().min(0).max(32),
    has_more: z.boolean(),
    pins: z.array(pin).max(OUTBOX_RECOVERY_CONTEXT_PIN_PAGE),
  }),
  z.strictObject({
    ...common,
    part: z.literal('candidates'),
    offset: z.number().int().min(0).max(500),
    total_count: z.number().int().min(0).max(500),
    next_offset: z.number().int().min(0).max(500),
    has_more: z.boolean(),
    candidates: z.array(candidate).max(OUTBOX_RECOVERY_CONTEXT_CANDIDATE_PAGE),
  }),
  z.strictObject({
    ...common,
    part: z.literal('receipts'),
    mode: z.union([wordStudyModeSchema, noteStudyModeSchema]),
    offset: z.literal(0),
    total_count: z
      .number()
      .int()
      .min(1)
      .max(OUTBOX_RECOVERY_CONTEXT_RECEIPT_PAGE),
    next_offset: z
      .number()
      .int()
      .min(1)
      .max(OUTBOX_RECOVERY_CONTEXT_RECEIPT_PAGE),
    has_more: z.literal(false),
    receipts: outboxReceiptDataSchema.shape.receipts.max(
      OUTBOX_RECOVERY_CONTEXT_RECEIPT_PAGE
    ),
  }),
]);
export type OutboxRecoveryContextRequest = z.infer<
  typeof outboxRecoveryContextRequestSchema
>;
export type OutboxRecoveryContextData = z.infer<
  typeof outboxRecoveryContextDataSchema
>;

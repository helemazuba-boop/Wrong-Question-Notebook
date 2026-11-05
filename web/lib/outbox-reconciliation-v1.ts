import { z } from 'zod';
import { requestMetadataSchema } from './device-control-v3';
import {
  wordObservationActionSchema,
  wordStudyModeSchema,
} from './word-study-v1';
import {
  noteObservationActionSchema,
  noteStudyModeSchema,
} from './note-study-v1';

export const OUTBOX_RECONCILIATION_CONTRACT =
  'outbox-reconciliation-v1' as const;
export const OUTBOX_RECEIPTS_MAX_ITEMS = 64;
export const OUTBOX_RECEIPTS_MAX_BYTES = 16 * 1024;
export const OUTBOX_RECEIPTS_MAX_RESPONSE_BYTES = 64 * 1024;
export const OUTBOX_RECEIPTS_RPC_TIMEOUT_MS = 5000;

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const requestId = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.string().datetime({ offset: true });

export const outboxReceiptRequestSchema = requestMetadataSchema.extend({
  contract: z.literal(OUTBOX_RECONCILIATION_CONTRACT),
  domain: z.enum(['word', 'note']),
  session_id: z.uuid(),
  request_ids: z
    .array(requestId)
    .min(1)
    .max(OUTBOX_RECEIPTS_MAX_ITEMS)
    .refine(
      ids => new Set(ids).size === ids.length,
      'Request IDs must be unique'
    ),
});

const sessionFields = {
  session_id: z.uuid(),
  status: z.enum(['active', 'paused', 'completed', 'abandoned']),
  next_sequence: counter,
  expires_at: timestamp,
};

const session = z.discriminatedUnion('domain', [
  z.strictObject({
    ...sessionFields,
    domain: z.literal('word'),
    mode: wordStudyModeSchema,
  }),
  z.strictObject({
    ...sessionFields,
    domain: z.literal('note'),
    mode: noteStudyModeSchema,
  }),
]);

const observation = z.strictObject({
  observation_id: z.uuid(),
  request_id: requestId,
  session_id: z.uuid(),
  sequence: counter,
  item_id: z.uuid(),
  action: z.union([wordObservationActionSchema, noteObservationActionSchema]),
  mode: z.union([wordStudyModeSchema, noteStudyModeSchema]),
  occurred_at: timestamp,
  created_at: timestamp,
});

export const outboxReceiptDataSchema = z.strictObject({
  contract: z.literal(OUTBOX_RECONCILIATION_CONTRACT),
  read_at: timestamp,
  actor: z.strictObject({ user_id: z.uuid(), device_id: z.uuid() }),
  session,
  receipts: z
    .array(
      z.discriminatedUnion('state', [
        z.strictObject({
          request_id: requestId,
          state: z.literal('found'),
          observation,
        }),
        z.strictObject({
          request_id: requestId,
          state: z.enum(['not_found', 'conflict']),
          observation: z.null(),
        }),
      ])
    )
    .min(1)
    .max(OUTBOX_RECEIPTS_MAX_ITEMS),
  repair_authorized: z.literal(false),
});

export type OutboxReceiptRequest = z.infer<typeof outboxReceiptRequestSchema>;
export type OutboxReceiptData = z.infer<typeof outboxReceiptDataSchema>;

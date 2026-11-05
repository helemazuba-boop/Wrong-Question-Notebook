import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { wordObservationActionSchema } from './word-study-v1';
import { noteObservationActionSchema } from './note-study-v1';
import {
  outboxReceiptDataSchema,
  outboxReceiptRequestSchema,
  OUTBOX_RECEIPTS_RPC_TIMEOUT_MS,
  type OutboxReceiptRequest,
} from './outbox-reconciliation-v1';

export class OutboxReceiptError extends Error {
  constructor(
    public code: string,
    public status: number,
    public retryable: boolean
  ) {
    super(code);
  }
}

function unavailable(): never {
  throw new OutboxReceiptError('OUTBOX_RECEIPTS_UNAVAILABLE', 503, true);
}

function sameUuid(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

// This deliberately has no record/skip RPC, projection wake, control replay
// cache or ACK. Missing/conflicting receipts are evidence, never permission to
// replay or remove a local record. All data belongs to the authenticated device.
export async function readOutboxReceipts(
  client: Pick<SupabaseClient<Database>, 'rpc'>,
  userId: string,
  deviceId: string,
  input: OutboxReceiptRequest
) {
  const request = outboxReceiptRequestSchema.parse(input);
  const { data, error } = await client
    .rpc('lookup_device_outbox_receipts_v1', {
      p_user_id: userId,
      p_device_id: deviceId,
      p_domain: request.domain,
      p_session_id: request.session_id,
      p_request_ids: request.request_ids,
    })
    .abortSignal(AbortSignal.timeout(OUTBOX_RECEIPTS_RPC_TIMEOUT_MS));
  if (error) unavailable();
  if (data === null) {
    // Identical answer for absent, wrong-domain and unowned sessions.
    throw new OutboxReceiptError('OUTBOX_SESSION_UNAVAILABLE', 404, false);
  }
  const parsed = outboxReceiptDataSchema.safeParse(data);
  if (!parsed.success) unavailable();
  const receipt = parsed.data;
  if (
    !sameUuid(receipt.actor.user_id, userId) ||
    !sameUuid(receipt.actor.device_id, deviceId) ||
    !sameUuid(receipt.session.session_id, request.session_id) ||
    receipt.session.domain !== request.domain ||
    receipt.receipts.length !== request.request_ids.length
  )
    unavailable();
  const actions =
    request.domain === 'word'
      ? wordObservationActionSchema
      : noteObservationActionSchema;
  for (let index = 0; index < request.request_ids.length; index += 1) {
    const entry = receipt.receipts[index];
    if (entry.request_id !== request.request_ids[index]) unavailable();
    if (
      entry.state === 'found' &&
      (entry.observation.request_id !== entry.request_id ||
        !sameUuid(entry.observation.session_id, request.session_id) ||
        entry.observation.mode !== receipt.session.mode ||
        !actions.safeParse(entry.observation.action).success)
    )
      unavailable();
  }
  return receipt;
}

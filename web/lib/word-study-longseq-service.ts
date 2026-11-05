import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalJson } from './device-control-v3-idempotency';
import type { Database } from './database.types';
import { WordStudyServiceError } from './word-study-service';
import { wakeWordProgressProjection } from './word-progress-wake';
import type {
  RegisterLocalWordStudySessionData,
  RegisterLocalWordStudySessionRequest,
  WordObservationBatchData,
  WordObservationBatchRequest,
} from './word-study-longseq-v1';
import {
  WORD_LOCAL_SESSION_SEMANTICS,
  registerLocalWordStudySessionDataSchema,
  wordObservationBatchDataSchema,
} from './word-study-longseq-v1';

export type WordLongseqServiceClient = Pick<SupabaseClient<Database>, 'rpc'>;

// Immutable retry identity: metadata that changes across boots, transport
// request IDs and the outer envelope are intentionally excluded.
export function localSessionSemanticFingerprint(
  input: RegisterLocalWordStudySessionRequest
): string {
  const canonical = canonicalJson({
    protocol: 'word-local-session-v1',
    session_id: input.session_id,
    scope: input.scope,
    seed: input.seed,
    start_index: input.start_index,
    snapshot: input.snapshot,
    items: input.items,
  });
  return createSemanticSha(canonical);
}

function createSemanticSha(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function rpcFailure(error: unknown, action: string): never {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : '';
  if (message.includes('WORD_LOCAL_SESSION_CONFLICT')) {
    throw new WordStudyServiceError(
      'LOCAL_SESSION_CONFLICT',
      'Session ID is registered with different immutable semantics',
      409
    );
  }
  if (message.includes('WORD_LOCAL_SESSION_ACTOR_CONFLICT')) {
    throw new WordStudyServiceError(
      'LOCAL_SESSION_ACTOR_CONFLICT',
      'Session ID belongs to another actor',
      409
    );
  }
  if (message.includes('WORD_LOCAL_DEVICE_NOT_OWNED')) {
    throw new WordStudyServiceError(
      'DEVICE_NOT_OWNED',
      'Device is not owned by the authenticated user',
      403
    );
  }
  if (message.includes('WORD_LOCAL_DECK_NOT_VISIBLE')) {
    throw new WordStudyServiceError(
      'WORD_SCOPE_NOT_VISIBLE',
      'Word study scope is not visible',
      403
    );
  }
  if (message.includes('WORD_LOCAL_SCOPE_SNAPSHOT_MISMATCH')) {
    throw new WordStudyServiceError(
      'SCOPE_SNAPSHOT_MISMATCH',
      'Snapshot deck IDs must exactly match scope deck IDs',
      409
    );
  }
  if (message.includes('WORD_LOCAL_ITEM_NOT_IN_SCOPE')) {
    throw new WordStudyServiceError(
      'ITEM_NOT_IN_SCOPE',
      'Candidate item deck is outside the pinned scope',
      409
    );
  }
  if (message.includes('WORD_LOCAL_ITEM_NOT_IN_DECK')) {
    throw new WordStudyServiceError(
      'ITEM_NOT_IN_DECK',
      'Candidate item does not belong to its declared deck',
      409
    );
  }
  if (message.includes('WORD_LOCAL_PACK_NOT_FOUND')) {
    throw new WordStudyServiceError(
      'PACK_REVISION_CHANGED',
      'Pinned historical word pack was not found',
      409
    );
  }
  if (message.includes('WORD_LOCAL_SNAPSHOT_INVALID')) {
    throw new WordStudyServiceError(
      'INVALID_SNAPSHOT',
      'Word pack snapshot is invalid',
      409
    );
  }
  if (message.includes('WORD_LOCAL_ORDINAL_INVALID')) {
    throw new WordStudyServiceError(
      'INVALID_CANDIDATE_ORDINAL',
      'Candidate ordinals must be continuous and unique',
      409
    );
  }
  if (message.includes('WORD_LOCAL_ITEM_DUPLICATE')) {
    throw new WordStudyServiceError(
      'DUPLICATE_CANDIDATE_ITEM',
      'Candidate item IDs must be unique',
      409
    );
  }
  if (message.includes('INVALID_STUDY_SESSION')) {
    throw new WordStudyServiceError(
      'INVALID_REQUEST',
      'Local session request failed database validation',
      400
    );
  }
  if (message.includes('INVALID_STUDY_OBSERVATION')) {
    throw new WordStudyServiceError(
      'INVALID_REQUEST',
      'Observation batch failed database validation',
      400
    );
  }
  if (message.includes('STUDY_SESSION_ACTOR_MISMATCH')) {
    throw new WordStudyServiceError(
      'SESSION_ACTOR_MISMATCH',
      'Study session belongs to another actor',
      403
    );
  }
  throw new WordStudyServiceError(
    'WORD_STUDY_UNAVAILABLE',
    `Word study ${action} unavailable`,
    503,
    true
  );
}

export async function registerLocalWordStudySession(
  supabase: WordLongseqServiceClient,
  userId: string,
  deviceId: string,
  input: RegisterLocalWordStudySessionRequest
): Promise<RegisterLocalWordStudySessionData> {
  const { data, error } = await supabase.rpc(
    'register_local_word_study_session_v1',
    {
      p_user_id: userId,
      p_device_id: deviceId,
      p_session_id: input.session_id,
      p_create_request_id: input.request_id,
      p_fingerprint: localSessionSemanticFingerprint(input),
      p_scope: input.scope,
      p_seed: input.seed,
      p_start_index: input.start_index,
      p_snapshot: input.snapshot,
      p_candidate_items: input.items,
    }
  );
  if (error) rpcFailure(error, 'registration');
  return registerLocalWordStudySessionDataSchema.parse(data);
}

function receiptFailure(): never {
  throw new WordStudyServiceError(
    'INVALID_STUDY_RESULT',
    'Word study service returned an invalid batch receipt',
    503,
    true
  );
}

function validateBatchReceipt(
  input: WordObservationBatchRequest,
  data: WordObservationBatchData
): void {
  if (data.session_id !== input.session_id) receiptFailure();
  if (data.accepted.length > input.observations.length) receiptFailure();
  if (data.accepted.length === 0 && data.failure === null) receiptFailure();
  if (
    data.accepted.length === input.observations.length &&
    data.failure !== null
  ) {
    receiptFailure();
  }
  if (
    data.accepted.length < input.observations.length &&
    data.failure === null
  ) {
    receiptFailure();
  }
  for (let index = 0; index < data.accepted.length; index += 1) {
    const expected = input.observations[index];
    const actual = data.accepted[index];
    if (
      actual.request_id !== expected.request_id ||
      actual.sequence !== expected.sequence
    ) {
      receiptFailure();
    }
  }
  if (data.failure) {
    const expected = input.observations[data.accepted.length];
    if (
      !expected ||
      data.failure.request_id !== expected.request_id ||
      data.failure.sequence !== expected.sequence
    ) {
      receiptFailure();
    }
  }
}

export async function recordWordStudyObservationBatch(
  supabase: WordLongseqServiceClient,
  userId: string,
  deviceId: string,
  input: WordObservationBatchRequest
): Promise<WordObservationBatchData> {
  const { data, error } = await supabase.rpc(
    'record_word_study_observation_batch_v1',
    {
      p_user_id: userId,
      p_device_id: deviceId,
      p_session_id: input.session_id,
      p_observations: input.observations,
    }
  );
  if (error) rpcFailure(error, 'batch');
  const parsed = wordObservationBatchDataSchema.safeParse(data);
  if (!parsed.success) receiptFailure();
  validateBatchReceipt(input, parsed.data);
  // The batch RPC calls the original observation RPC, which may return an
  // fsrs-authority result. One wake is enough for the whole newly accepted
  // prefix; replayed facts are already durable and need no projection wake.
  if (parsed.data.accepted.some(accepted => !accepted.replayed)) {
    wakeWordProgressProjection();
  }
  return parsed.data;
}

export const LOCAL_WORD_STUDY_FIXED_SEMANTICS = WORD_LOCAL_SESSION_SEMANTICS;

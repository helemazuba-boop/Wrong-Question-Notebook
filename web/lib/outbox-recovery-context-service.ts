import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import {
  wordStudyModeSchema,
  wordObservationActionSchema,
} from './word-study-v1';
import {
  noteStudyModeSchema,
  noteObservationActionSchema,
} from './note-study-v1';
import {
  OUTBOX_RECOVERY_CONTEXT_TIMEOUT_MS,
  OUTBOX_RECOVERY_CONTEXT_CANDIDATE_PAGE,
  OUTBOX_RECOVERY_CONTEXT_PIN_PAGE,
  outboxRecoveryContextRequestSchema,
  outboxRecoveryContextDataSchema,
  type OutboxRecoveryContextRequest,
} from './outbox-recovery-context-v1';

export class OutboxRecoveryContextError extends Error {
  constructor(
    public code: string,
    public status: number,
    public retryable: boolean
  ) {
    super(code);
  }
}
function unavailable(): never {
  throw new OutboxRecoveryContextError(
    'OUTBOX_RECOVERY_CONTEXT_UNAVAILABLE',
    503,
    true
  );
}
function sameUuid(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
const wordOrder = {
  sequential: ['study', 'sequential'],
  random: ['study', 'guided_random_v1'],
  dictionary: ['lookup', 'lexicographic'],
  review: ['study', 'due_queue_v1'],
  intake: ['study', 'new_intake_v1'],
  shuffle: ['study', 'pure_random_v1'],
  mistakes: ['study', 'mistake_words_v1'],
} as const;

// No replay cache, lifecycle refresh, mutation RPC or source-MAC fallback.
// Registry observations are evidence; none authorizes repair or attests a
// historical content_revision. Use expected identity on every follow-up page.
export async function readOutboxRecoveryContext(
  client: Pick<SupabaseClient<Database>, 'rpc'>,
  userId: string,
  deviceId: string,
  input: OutboxRecoveryContextRequest,
  sourceMac: string,
  tokenSha256: string,
  signal?: AbortSignal
) {
  const request = outboxRecoveryContextRequestSchema.parse(input);
  if (!/^[0-9a-f]{12}$/.test(sourceMac))
    throw new OutboxRecoveryContextError('INVALID_SOURCE_MAC', 400, false);
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) unavailable();
  const timeout = AbortSignal.timeout(OUTBOX_RECOVERY_CONTEXT_TIMEOUT_MS);
  const { data, error } = await client
    .rpc('read_device_outbox_recovery_context_v1', {
      p_user_id: userId,
      p_device_id: deviceId,
      p_domain: request.domain,
      p_session_id: request.session_id,
      p_source_mac: sourceMac,
      p_nonce: request.nonce,
      p_manifest_sha256: request.manifest_sha256,
      p_elf_sha256: request.elf_sha256,
      p_part: request.part,
      p_offset: request.offset,
      p_expected_context_sha256: request.expected_context_sha256,
      p_token_sha256: tokenSha256,
      p_request_ids: request.part === 'receipts' ? request.request_ids : [],
    })
    .abortSignal(signal ? AbortSignal.any([signal, timeout]) : timeout);
  if (error) {
    if (
      error.code === '40001' &&
      error.message === 'OUTBOX_RECOVERY_CONTEXT_CHANGED'
    )
      throw new OutboxRecoveryContextError(
        'OUTBOX_RECOVERY_CONTEXT_CHANGED',
        409,
        true
      );
    if (
      error.code === '22023' &&
      error.message === 'INVALID_OUTBOX_RECOVERY_CONTEXT_OFFSET'
    )
      throw new OutboxRecoveryContextError('INVALID_REQUEST', 400, false);
    unavailable();
  }
  if (data === null)
    throw new OutboxRecoveryContextError(
      'OUTBOX_SESSION_UNAVAILABLE',
      404,
      false
    );
  const parsed = outboxRecoveryContextDataSchema.safeParse(data);
  if (!parsed.success) unavailable();
  const result = parsed.data;
  if (
    !sameUuid(result.actor.user_id, userId) ||
    !sameUuid(result.actor.device_id, deviceId) ||
    !sameUuid(result.session_id, request.session_id) ||
    result.domain !== request.domain ||
    result.part !== request.part ||
    result.offset !== request.offset ||
    result.binding.source_mac !== sourceMac ||
    result.binding.nonce !== request.nonce ||
    result.binding.manifest_sha256 !== request.manifest_sha256 ||
    result.binding.elf_sha256 !== request.elf_sha256 ||
    (request.expected_context_sha256 !== null &&
      result.context_sha256 !== request.expected_context_sha256)
  )
    unavailable();
  if (result.part === 'session') {
    const s = result.session;
    if (
      !sameUuid(s.session_id, result.session_id) ||
      s.domain !== result.domain
    )
      unavailable();
    if (s.domain === 'word') {
      const [purpose, order] = wordOrder[s.mode];
      if (s.purpose !== purpose || s.ordering !== order) unavailable();
    } else if (
      s.ordering !==
      (s.mode === 'sequential'
        ? 'sequential_note_v1'
        : 'least_recently_viewed_v1')
    )
      unavailable();
    if (s.local_session) {
      if (
        s.domain !== 'word' ||
        !['sequential', 'shuffle'].includes(s.mode) ||
        s.local_start_index === null ||
        s.local_fingerprint === null
      )
        unavailable();
    } else if (s.local_start_index !== null || s.local_fingerprint !== null)
      unavailable();
    return result;
  }
  if (result.part === 'receipts') {
    if (
      request.part !== 'receipts' ||
      result.total_count !== request.request_ids.length ||
      result.next_offset !== result.total_count ||
      result.receipts.length !== result.total_count
    )
      unavailable();
    const word = result.domain === 'word';
    const modes = word ? wordStudyModeSchema : noteStudyModeSchema;
    const actions = word
      ? wordObservationActionSchema
      : noteObservationActionSchema;
    if (!modes.safeParse(result.mode).success) unavailable();
    for (const [index, row] of result.receipts.entries()) {
      if (row.request_id !== request.request_ids[index]) unavailable();
      if (row.state !== 'found') continue;
      if (
        row.observation.request_id !== row.request_id ||
        !sameUuid(row.observation.session_id, result.session_id) ||
        row.observation.mode !== result.mode ||
        !actions.safeParse(row.observation.action).success
      )
        unavailable();
    }
    return result;
  }
  const rows = result.part === 'pins' ? result.pins : result.candidates;
  const limit =
    result.part === 'pins'
      ? OUTBOX_RECOVERY_CONTEXT_PIN_PAGE
      : OUTBOX_RECOVERY_CONTEXT_CANDIDATE_PAGE;
  if (
    result.offset > result.total_count ||
    rows.length !== Math.min(limit, result.total_count - result.offset) ||
    result.next_offset !== result.offset + rows.length ||
    result.has_more !== result.next_offset < result.total_count
  )
    unavailable();
  if (rows.some((row, i) => row.index !== result.offset + i)) unavailable();
  if (result.part === 'pins') {
    for (const row of result.pins) {
      const word = 'deck_id' in row.pin;
      if (word !== (result.domain === 'word')) unavailable();
      if (row.registry.kind === 'word_ready_registry') {
        if (!('deck_id' in row.pin)) unavailable();
        const record = row.registry.record;
        if (
          record &&
          (record.pack_revision !== row.pin.pack_revision ||
            record.sha256 !== row.pin.sha256)
        )
          unavailable();
      } else {
        if (!('notebook_id' in row.pin)) unavailable();
        const record = row.registry.record;
        if (
          record &&
          (!sameUuid(record.logical_id, row.pin.notebook_id) ||
            record.sha256 !== row.pin.sha256)
        )
          unavailable();
      }
    }
  } else if (
    result.candidates.some(
      row => 'deck_id' in row.item !== (result.domain === 'word')
    )
  )
    unavailable();
  return result;
}

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/lib/database.types';

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

// Same lesson as lib/fsrs/authority-control.ts: persisted user ids are not
// always RFC 9562 UUIDs (seeded accounts use 00000000-...-000000000002), so
// z.guid() is the only schema that accepts every real id.
export const WordCutoverExpectationSchema = z
  .object({
    word_entry_id: z.uuid(),
    projection_revision: z.number().int().nonnegative(),
    timeline_fingerprint: fingerprintSchema,
  })
  .strict();

export const WordSchedulerAuthorityActionSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('cutover'),
        user_id: z.guid(),
        expected_projections: z.array(WordCutoverExpectationSchema),
      })
      .strict(),
    z
      .object({
        action: z.literal('cancel'),
        user_id: z.guid(),
        cutover_id: z.guid(),
      })
      .strict(),
  ]
);

const WordCutoverResultSchema = z
  .object({
    cutover_id: z.guid(),
    user_id: z.guid(),
    authority_mode: z.literal('fsrs'),
    word_count: z.number().int().nonnegative(),
  })
  .strict();

const WordCancelResultSchema = z
  .object({
    cutover_id: z.guid(),
    user_id: z.guid(),
    authority_mode: z.literal('sm2'),
    restored_word_count: z.number().int().nonnegative(),
  })
  .strict();

export type WordSchedulerAuthorityAction = z.infer<
  typeof WordSchedulerAuthorityActionSchema
>;

export class WordSchedulerAuthorityControlError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
    this.name = 'WordSchedulerAuthorityControlError';
  }
}

function mapWordAuthorityError(error: { message?: string }): never {
  const message = String(error.message ?? '');
  const knownCode = [
    'FSRS_CUTOVER_NOT_AVAILABLE',
    'FSRS_CUTOVER_PROJECTION_MISSING',
    'FSRS_CUTOVER_PROJECTION_DIRTY',
    'FSRS_CUTOVER_EXPECTATION_MISMATCH',
    'FSRS_CUTOVER_PROJECTION_STALE',
    'FSRS_CUTOVER_NOT_ACTIVE',
    'FSRS_CUTOVER_HAS_NEW_REVIEWS',
  ].find(code => message.includes(code));

  if (knownCode) {
    throw new WordSchedulerAuthorityControlError(knownCode, 409);
  }
  if (message.includes('INVALID_FSRS_CUTOVER_EXPECTATIONS')) {
    throw new WordSchedulerAuthorityControlError(
      'INVALID_FSRS_CUTOVER_EXPECTATIONS',
      400
    );
  }
  throw new WordSchedulerAuthorityControlError(
    'WORD_SCHEDULER_AUTHORITY_CONTROL_FAILED',
    500
  );
}

export async function applyWordSchedulerAuthorityAction(
  supabase: SupabaseClient<Database>,
  action: WordSchedulerAuthorityAction
) {
  if (action.action === 'cutover') {
    const { data, error } = await supabase.rpc(
      'cutover_user_word_progress_to_fsrs',
      {
        p_user_id: action.user_id,
        p_expected_projections: action.expected_projections,
      }
    );
    if (error) mapWordAuthorityError(error);
    return WordCutoverResultSchema.parse(data);
  }

  const { data, error } = await supabase.rpc(
    'cancel_word_progress_fsrs_cutover',
    {
      p_user_id: action.user_id,
      p_cutover_id: action.cutover_id,
    }
  );
  if (error) mapWordAuthorityError(error);
  return WordCancelResultSchema.parse(data);
}

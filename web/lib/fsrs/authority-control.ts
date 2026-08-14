import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/lib/database.types';

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const FsrsCutoverExpectationSchema = z
  .object({
    problem_id: z.uuid(),
    projection_revision: z.number().int().nonnegative(),
    timeline_fingerprint: fingerprintSchema,
  })
  .strict();

export const FsrsAuthorityActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('cutover'),
      user_id: z.uuid(),
      expected_projections: z.array(FsrsCutoverExpectationSchema),
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      user_id: z.uuid(),
      cutover_id: z.uuid(),
    })
    .strict(),
]);

const FsrsCutoverResultSchema = z
  .object({
    cutover_id: z.uuid(),
    user_id: z.uuid(),
    authority_mode: z.literal('fsrs'),
    problem_count: z.number().int().nonnegative(),
  })
  .strict();

const FsrsCancelResultSchema = z
  .object({
    cutover_id: z.uuid(),
    user_id: z.uuid(),
    authority_mode: z.literal('sm2'),
    restored_problem_count: z.number().int().nonnegative(),
  })
  .strict();

export type FsrsAuthorityAction = z.infer<typeof FsrsAuthorityActionSchema>;

export class FsrsAuthorityControlError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
    this.name = 'FsrsAuthorityControlError';
  }
}

function mapAuthorityError(error: { message?: string }): never {
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
    throw new FsrsAuthorityControlError(knownCode, 409);
  }
  if (message.includes('INVALID_FSRS_CUTOVER_EXPECTATIONS')) {
    throw new FsrsAuthorityControlError(
      'INVALID_FSRS_CUTOVER_EXPECTATIONS',
      400
    );
  }
  throw new FsrsAuthorityControlError('FSRS_AUTHORITY_CONTROL_FAILED', 500);
}

export async function applyFsrsAuthorityAction(
  supabase: SupabaseClient<Database>,
  action: FsrsAuthorityAction
) {
  if (action.action === 'cutover') {
    const { data, error } = await supabase.rpc(
      'cutover_user_review_schedule_to_fsrs',
      {
        p_user_id: action.user_id,
        p_expected_projections: action.expected_projections,
      }
    );
    if (error) mapAuthorityError(error);
    return FsrsCutoverResultSchema.parse(data);
  }

  const { data, error } = await supabase.rpc('cancel_fsrs_authority_cutover', {
    p_user_id: action.user_id,
    p_cutover_id: action.cutover_id,
  });
  if (error) mapAuthorityError(error);
  return FsrsCancelResultSchema.parse(data);
}

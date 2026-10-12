import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const ReportResolution = z
  .object({
    action: z.enum(['dismiss', 'hide', 'restore']),
    message: z.string().trim().min(1).max(1000),
  })
  .strict();
export interface ModerationReport {
  id: string;
  problem_set_id: string | null;
  target_title: string | null;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
  result_message: string | null;
  reviewed_at: string | null;
  resolution_action: string | null;
}
export const REPORT_RESULT_FIELDS =
  'id, problem_set_id, target_title, reason, details, status, created_at, result_message, reviewed_at, resolution_action';

export async function listModerationReports(
  client: SupabaseClient<any>,
  status: string,
  offset: number
) {
  let query = client
    .from('problem_set_reports')
    .select(REPORT_RESULT_FIELDS)
    .order('created_at')
    .order('id')
    .range(offset, offset + 49);
  if (status !== 'all') query = query.eq('status', status);
  const result = await query;
  if (result.error) throw new Error('Report queue is unavailable');
  return (result.data ?? []) as ModerationReport[];
}

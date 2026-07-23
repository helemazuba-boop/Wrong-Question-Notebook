import type { SupabaseClient } from '@supabase/supabase-js';
import { NotebookToolError } from '@/lib/notebooks';

// NotebookPermissionService centralizes every authorization decision for the
// notebook domain so Web, AI, and (later) device entry points share one owner /
// AI-access boundary instead of re-deriving checks in each route.

export interface NotebookAiAccess {
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
}

export interface NotebookOwnerRow {
  id: string;
  user_id: string;
  subject_id: string;
  archived_at: string | null;
  revision: number;
}

export interface RequireNotebookOwnerOptions {
  /** Allow resolving an archived notebook (needed by restore flows). */
  includeArchived?: boolean;
}

/**
 * Resolves a notebook the caller owns, throwing notebook_not_found otherwise.
 * Returns the row so callers can reuse subject_id / revision without a second
 * query. Active-only by default; archive/restore opt in via includeArchived.
 */
export async function requireNotebookOwner(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  options: RequireNotebookOwnerOptions = {}
): Promise<NotebookOwnerRow> {
  let query = supabase
    .from('notebooks')
    .select('id, user_id, subject_id, archived_at, revision')
    .eq('id', notebookId)
    .eq('user_id', userId);
  if (!options.includeArchived) {
    query = query.is('archived_at', null);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data) {
    throw new NotebookToolError(
      'notebook_not_found',
      'Notebook not found',
      404
    );
  }
  return data as NotebookOwnerRow;
}

/**
 * Confirms a linked problem belongs to the same user. Cross-user problem links
 * are rejected as not-found so ownership is never leaked.
 */
export async function requireLinkedProblemOwner(
  supabase: SupabaseClient<any>,
  userId: string,
  problemId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('problems')
    .select('id')
    .eq('id', problemId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data) {
    throw new NotebookToolError('problem_not_found', 'Problem not found', 404);
  }
}

export async function getAiAccess(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string
): Promise<NotebookAiAccess> {
  const { data, error } = await supabase
    .from('notebook_ai_access')
    .select('can_read, can_create, can_update')
    .eq('user_id', userId)
    .eq('notebook_id', notebookId)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  return {
    can_read: Boolean(data?.can_read),
    can_create: Boolean(data?.can_create),
    can_update: Boolean(data?.can_update),
  };
}

/**
 * Persists an AI-access grant. v1 deliberately never enables can_update: the
 * update tool does not exist yet, so allowing the flag would be a lie. The
 * value is forced to false regardless of the request.
 */
export async function updateAiAccess(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  access: NotebookAiAccess
): Promise<NotebookAiAccess> {
  await requireNotebookOwner(supabase, userId, notebookId);
  const { data, error } = await supabase
    .from('notebook_ai_access')
    .upsert(
      {
        user_id: userId,
        notebook_id: notebookId,
        can_read: access.can_read,
        can_create: access.can_create,
        can_update: false,
      },
      { onConflict: 'user_id,notebook_id' }
    )
    .select('can_read, can_create, can_update')
    .single();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  return {
    can_read: Boolean(data.can_read),
    can_create: Boolean(data.can_create),
    can_update: Boolean(data.can_update),
  };
}

export function requireAiRead(access: NotebookAiAccess): void {
  if (!access.can_read) {
    throw new NotebookToolError(
      'notebook_permission_denied',
      'AI has no permission to read that notebook',
      403
    );
  }
}

export function requireAiCreate(access: NotebookAiAccess): void {
  if (!access.can_create) {
    throw new NotebookToolError(
      'notebook_permission_denied',
      'AI has no permission to write that notebook',
      403
    );
  }
}

export function requireAiUpdate(access: NotebookAiAccess): void {
  // can_update is never granted in v1. Kept for symmetry so a future update
  // tool has a single, auditable gate to relax.
  if (!access.can_update) {
    throw new NotebookToolError(
      'notebook_permission_denied',
      'AI has no permission to update that notebook',
      403
    );
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Json } from '@/lib/database.types';
import { NotebookToolError } from '@/lib/notebooks';
import {
  NOTE_CONTENT_FORMAT,
  normalizeNoteContent,
  normalizeNoteTitle,
  validateNoteContent,
  validateNoteTitle,
} from '@/lib/note-content-format';
import {
  requireLinkedProblemOwner,
  requireNotebookOwner,
} from '@/lib/notebook-permission-service';

// NotebookContentService is the single writer/reader for notebook + note
// content. Every entry point (Web, AI, device) funnels through it so owner
// checks, revision CAS, the frozen content format, and stable ordering are
// enforced in exactly one place.

const NOTE_COLUMNS =
  'id, notebook_id, title, content, content_format, source, linked_problem_id, metadata, assets, revision, sort_index, created_at, updated_at, archived_at';
const NOTEBOOK_COLUMNS =
  'id, subject_id, title, description, color, icon, revision, created_at, updated_at, archived_at';

export const NOTE_LIST_ORDERS = ['stable', 'updated_desc', 'title'] as const;
export type NoteListOrder = (typeof NOTE_LIST_ORDERS)[number];

export const NOTE_LIST_DEFAULT_LIMIT = 20;
export const NOTE_LIST_MAX_LIMIT = 100;

export type NoteSource = 'user' | 'ai' | 'import';

// Mirror of the problem `assets` model plus the e-ink derivation the device
// consumes. `image_id` is the SHA-256 of the derived WQNI file.
export interface NoteImageAsset {
  path: string;
  pipeline_version?: string;
  image_id: string;
  display_path: string;
  preview_path: string;
  gray4_image_id?: string;
  gray4_display_path?: string;
  gray4_preview_path?: string;
}

export const NOTE_IMAGE_MAX_PER_NOTE = 4;

export interface NoteRecord {
  id: string;
  notebook_id: string;
  subject_id: string;
  title: string;
  content: string;
  content_format: string;
  source: string;
  linked_problem_id: string | null;
  metadata: Json;
  assets: NoteImageAsset[];
  revision: number;
  sort_index: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  read_state?: {
    state: 'unread' | 'reading' | 'completed';
    last_opened_at: string | null;
    last_completed_at: string | null;
    completed_count: number;
  };
  linked_problem?: {
    problem_id: string;
    problem_set_id: string | null;
    subject_id: string;
    title: string;
    status: string;
  } | null;
}

export interface NotebookRecord {
  id: string;
  subject_id: string;
  title: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface NoteListResult {
  notes: NoteRecord[];
  next_cursor: string | null;
  has_more: boolean;
  order: NoteListOrder;
}

interface NoteCursorPayload {
  o: NoteListOrder;
  k: string | number;
  id: string;
}

function mapNoteAssets(value: unknown): NoteImageAsset[] {
  if (!Array.isArray(value)) return [];
  const assets: NoteImageAsset[] = [];
  for (const entry of value) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as any).path === 'string' &&
      typeof (entry as any).image_id === 'string' &&
      typeof (entry as any).display_path === 'string' &&
      typeof (entry as any).preview_path === 'string'
    ) {
      assets.push({
        path: (entry as any).path,
        ...(typeof (entry as any).pipeline_version === 'string'
          ? { pipeline_version: (entry as any).pipeline_version }
          : {}),
        image_id: (entry as any).image_id,
        display_path: (entry as any).display_path,
        preview_path: (entry as any).preview_path,
        ...(typeof (entry as any).gray4_image_id === 'string' &&
        typeof (entry as any).gray4_display_path === 'string'
          ? {
              gray4_image_id: (entry as any).gray4_image_id,
              gray4_display_path: (entry as any).gray4_display_path,
              ...(typeof (entry as any).gray4_preview_path === 'string'
                ? {
                    gray4_preview_path: (entry as any).gray4_preview_path,
                  }
                : {}),
            }
          : {}),
      });
    }
  }
  return assets;
}

function mapNote(row: any, subjectId: string): NoteRecord {
  return {
    id: row.id,
    notebook_id: row.notebook_id,
    subject_id: subjectId,
    title: row.title,
    content: row.content,
    content_format: row.content_format ?? NOTE_CONTENT_FORMAT,
    source: row.source,
    linked_problem_id: row.linked_problem_id ?? null,
    metadata: (row.metadata ?? {}) as Json,
    assets: mapNoteAssets(row.assets),
    revision: Number(row.revision ?? 1),
    sort_index: Number(row.sort_index ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

async function enrichNoteReadingContext(
  supabase: SupabaseClient<any>,
  userId: string,
  notes: NoteRecord[]
): Promise<NoteRecord[]> {
  if (!notes.length) return notes;
  const noteIds = notes.map(note => note.id);
  const problemIds = notes.flatMap(note =>
    note.linked_problem_id ? [note.linked_problem_id] : []
  );
  const [{ data: states, error: stateError }, problemResult, linkResult] =
    await Promise.all([
      supabase
        .from('note_read_state')
        .select('note_id, last_opened_at, last_completed_at, completed_count')
        .eq('user_id', userId)
        .in('note_id', noteIds),
      problemIds.length
        ? supabase
            .from('problems')
            .select('id, title, status, subject_id')
            .eq('user_id', userId)
            .in('id', [...new Set(problemIds)])
        : Promise.resolve({ data: [], error: null }),
      problemIds.length
        ? supabase
            .from('problem_set_problems')
            .select('problem_id, problem_set_id')
            .in('problem_id', [...new Set(problemIds)])
        : Promise.resolve({ data: [], error: null }),
    ]);
  if (stateError || problemResult.error || linkResult.error) {
    throw new NotebookToolError(
      'database_error',
      (stateError || problemResult.error || linkResult.error)?.message ||
        'Failed to load note reading context',
      500
    );
  }
  const stateByNote = new Map(
    (states || []).map((row: any) => [row.note_id, row])
  );
  const problemById = new Map(
    (problemResult.data || []).map((row: any) => [row.id, row])
  );
  const setByProblem = new Map<string, string>();
  for (const row of linkResult.data || []) {
    if (!setByProblem.has(row.problem_id)) {
      setByProblem.set(row.problem_id, row.problem_set_id);
    }
  }
  return notes.map(note => {
    const state = stateByNote.get(note.id);
    const problem = note.linked_problem_id
      ? problemById.get(note.linked_problem_id)
      : null;
    return {
      ...note,
      read_state: {
        state: state?.last_completed_at
          ? 'completed'
          : state?.last_opened_at
            ? 'reading'
            : 'unread',
        last_opened_at: state?.last_opened_at || null,
        last_completed_at: state?.last_completed_at || null,
        completed_count: Number(state?.completed_count || 0),
      },
      linked_problem: problem
        ? {
            problem_id: problem.id,
            problem_set_id: setByProblem.get(problem.id) || null,
            subject_id: problem.subject_id,
            title: problem.title,
            status: problem.status,
          }
        : null,
    };
  });
}

function mapNotebook(row: any): NotebookRecord {
  return {
    id: row.id,
    subject_id: row.subject_id,
    title: row.title,
    description: row.description ?? null,
    color: row.color ?? null,
    icon: row.icon ?? null,
    revision: Number(row.revision ?? 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

export function encodeNoteCursor(
  order: NoteListOrder,
  note: NoteRecord
): string {
  const key: string | number =
    order === 'stable'
      ? note.sort_index
      : order === 'title'
        ? note.title
        : note.updated_at;
  const payload: NoteCursorPayload = { o: order, k: key, id: note.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeNoteCursor(
  cursor: string,
  order: NoteListOrder
): NoteCursorPayload {
  let payload: NoteCursorPayload;
  try {
    payload = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as NoteCursorPayload;
  } catch {
    throw new NotebookToolError('invalid_cursor', 'Cursor is malformed', 400);
  }
  if (!payload || payload.o !== order || typeof payload.id !== 'string') {
    throw new NotebookToolError(
      'invalid_cursor',
      'Cursor does not match the requested order',
      400
    );
  }
  return payload;
}

// Escapes a value for use inside a PostgREST or() filter: wrap in double quotes
// and escape backslashes/quotes so titles containing commas or parentheses do
// not break filter parsing. Mirrors the escaping used by searchUserProblems.
function orValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function getNotebook(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string
): Promise<NotebookRecord> {
  await requireNotebookOwner(supabase, userId, notebookId);
  const { data, error } = await supabase
    .from('notebooks')
    .select(NOTEBOOK_COLUMNS)
    .eq('id', notebookId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data) {
    throw new NotebookToolError(
      'notebook_not_found',
      'Notebook not found',
      404
    );
  }
  return mapNotebook(data);
}

export interface UpdateNotebookInput {
  expected_revision: number;
  title?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  subject_id?: string;
}

export async function updateNotebook(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  input: UpdateNotebookInput
): Promise<NotebookRecord> {
  await requireNotebookOwner(supabase, userId, notebookId);

  const patch: Record<string, unknown> = {
    revision: input.expected_revision + 1,
  };
  if (input.title !== undefined) {
    const title = normalizeNoteTitle(input.title);
    if (title.length < 1 || title.length > 80) {
      throw new NotebookToolError(
        'invalid_request',
        'Notebook title must be 1-80 characters',
        400
      );
    }
    patch.title = title;
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.color !== undefined) patch.color = input.color;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.subject_id !== undefined) patch.subject_id = input.subject_id;

  const { data, error } = await supabase
    .from('notebooks')
    .update(patch)
    .eq('id', notebookId)
    .eq('user_id', userId)
    .eq('revision', input.expected_revision)
    .is('archived_at', null)
    .select(NOTEBOOK_COLUMNS)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data) {
    await assertRevisionConflict(supabase, 'notebooks', userId, notebookId);
  }
  return mapNotebook(data);
}

export async function getNote(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  noteId: string
): Promise<NoteRecord> {
  const notebook = await requireNotebookOwner(supabase, userId, notebookId);
  const { data, error } = await supabase
    .from('notebook_notes')
    .select(NOTE_COLUMNS)
    .eq('id', noteId)
    .eq('notebook_id', notebookId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data) {
    throw new NotebookToolError('note_not_found', 'Note not found', 404);
  }
  return (
    await enrichNoteReadingContext(supabase, userId, [
      mapNote(data, notebook.subject_id),
    ])
  )[0];
}

export interface ListNotesInput {
  cursor?: string | null;
  limit?: number;
  query?: string | null;
  order?: NoteListOrder;
}

export async function listNotes(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  input: ListNotesInput = {}
): Promise<NoteListResult> {
  const notebook = await requireNotebookOwner(supabase, userId, notebookId);
  const order: NoteListOrder = input.order ?? 'stable';
  if (!NOTE_LIST_ORDERS.includes(order)) {
    throw new NotebookToolError('invalid_request', 'Invalid list order', 400);
  }
  const limit = Math.min(
    Math.max(input.limit ?? NOTE_LIST_DEFAULT_LIMIT, 1),
    NOTE_LIST_MAX_LIMIT
  );

  let query = supabase
    .from('notebook_notes')
    .select(NOTE_COLUMNS)
    .eq('notebook_id', notebookId)
    .eq('user_id', userId)
    .is('archived_at', null);

  const text = (input.query ?? '').trim();
  if (text) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const term = `"%${escaped}%"`;
    query = query.or(`title.ilike.${term},content.ilike.${term}`);
  }

  if (order === 'stable') {
    query = query.order('sort_index', { ascending: true }).order('id', {
      ascending: true,
    });
    if (input.cursor) {
      const payload = decodeNoteCursor(input.cursor, order);
      query = query.gt('sort_index', payload.k as number);
    }
  } else if (order === 'title') {
    query = query
      .order('title', { ascending: true })
      .order('id', { ascending: true });
    if (input.cursor) {
      const payload = decodeNoteCursor(input.cursor, order);
      const k = orValue(String(payload.k));
      query = query.or(`title.gt.${k},and(title.eq.${k},id.gt.${payload.id})`);
    }
  } else {
    query = query
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
    if (input.cursor) {
      const payload = decodeNoteCursor(input.cursor, order);
      const k = String(payload.k);
      query = query.or(
        `updated_at.lt.${k},and(updated_at.eq.${k},id.lt.${payload.id})`
      );
    }
  }

  // Fetch one extra row to determine has_more without a second count query.
  const { data, error } = await query.limit(limit + 1);
  if (error) throw new NotebookToolError('database_error', error.message, 500);

  const rows = (data || []) as any[];
  const hasMore = rows.length > limit;
  const mappedPage = rows
    .slice(0, limit)
    .map(row => mapNote(row, notebook.subject_id));
  const page = await enrichNoteReadingContext(supabase, userId, mappedPage);
  const nextCursor =
    hasMore && page.length > 0
      ? encodeNoteCursor(order, page[page.length - 1])
      : null;

  return { notes: page, next_cursor: nextCursor, has_more: hasMore, order };
}

export interface CreateNoteInput {
  title: string;
  content: string;
  source?: NoteSource;
  linked_problem_id?: string | null;
  metadata?: Json;
  client_request_id?: string | null;
  /** Conversation id recorded on AI-authored notes for the audit trail. */
  conversation_id?: string | null;
}

export async function createNote(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  input: CreateNoteInput
): Promise<NoteRecord> {
  const notebook = await requireNotebookOwner(supabase, userId, notebookId);

  const title = normalizeNoteTitle(input.title);
  const content = normalizeNoteContent(input.content);
  const titleError = validateNoteTitle(title);
  if (titleError) {
    throw new NotebookToolError('invalid_request', titleError.message, 400);
  }
  const contentError = validateNoteContent(content);
  if (contentError) {
    throw new NotebookToolError('invalid_request', contentError.message, 400);
  }
  if (input.linked_problem_id) {
    await requireLinkedProblemOwner(supabase, userId, input.linked_problem_id);
  }

  const source: NoteSource = input.source ?? 'user';
  const baseMetadata =
    input.metadata &&
    typeof input.metadata === 'object' &&
    !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : {};
  const metadata = {
    ...baseMetadata,
    ...(source === 'ai'
      ? { source_conversation_id: input.conversation_id ?? null }
      : {}),
  } as Json;

  const { data, error } = await supabase
    .from('notebook_notes')
    .insert({
      user_id: userId,
      notebook_id: notebookId,
      title,
      content,
      content_format: NOTE_CONTENT_FORMAT,
      source,
      linked_problem_id: input.linked_problem_id || null,
      metadata,
      client_request_id: input.client_request_id || null,
    })
    .select(NOTE_COLUMNS)
    .single();

  if (error) {
    // Idempotent replay: a retried create with the same client_request_id
    // returns the already-persisted note instead of a duplicate.
    if (isUniqueViolation(error) && input.client_request_id) {
      const existing = await findByClientRequestId(
        supabase,
        userId,
        input.client_request_id
      );
      if (existing) return mapNote(existing, notebook.subject_id);
    }
    throw new NotebookToolError('database_error', error.message, 500);
  }
  return mapNote(data, notebook.subject_id);
}

export interface UpdateNoteInput {
  expected_revision: number;
  title?: string;
  content?: string;
  linked_problem_id?: string | null;
  metadata?: Json;
}

export async function updateNote(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  noteId: string,
  input: UpdateNoteInput
): Promise<NoteRecord> {
  const notebook = await requireNotebookOwner(supabase, userId, notebookId);

  const patch: Record<string, unknown> = {
    revision: input.expected_revision + 1,
  };
  if (input.title !== undefined) {
    const title = normalizeNoteTitle(input.title);
    const titleError = validateNoteTitle(title);
    if (titleError) {
      throw new NotebookToolError('invalid_request', titleError.message, 400);
    }
    patch.title = title;
  }
  if (input.content !== undefined) {
    const content = normalizeNoteContent(input.content);
    const contentError = validateNoteContent(content);
    if (contentError) {
      throw new NotebookToolError('invalid_request', contentError.message, 400);
    }
    patch.content = content;
    patch.content_format = NOTE_CONTENT_FORMAT;
  }
  if (input.linked_problem_id !== undefined) {
    if (input.linked_problem_id) {
      await requireLinkedProblemOwner(
        supabase,
        userId,
        input.linked_problem_id
      );
    }
    patch.linked_problem_id = input.linked_problem_id;
  }
  if (input.metadata !== undefined) patch.metadata = input.metadata;

  const { data, error } = await supabase
    .from('notebook_notes')
    .update(patch)
    .eq('id', noteId)
    .eq('notebook_id', notebookId)
    .eq('user_id', userId)
    .eq('revision', input.expected_revision)
    .is('archived_at', null)
    .select(NOTE_COLUMNS)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data) {
    await assertNoteRevisionConflict(supabase, userId, notebookId, noteId);
  }
  return mapNote(data, notebook.subject_id);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

async function findByClientRequestId(
  supabase: SupabaseClient<any>,
  userId: string,
  clientRequestId: string
): Promise<any | null> {
  const { data } = await supabase
    .from('notebook_notes')
    .select(NOTE_COLUMNS)
    .eq('user_id', userId)
    .eq('client_request_id', clientRequestId)
    .maybeSingle();
  return data ?? null;
}

// Distinguishes a CAS miss between a genuine 404 and a revision conflict so the
// UI can prompt a reload instead of silently overwriting.
async function assertRevisionConflict(
  supabase: SupabaseClient<any>,
  table: 'notebooks',
  userId: string,
  id: string
): Promise<never> {
  const { data } = await supabase
    .from(table)
    .select('revision')
    .eq('id', id)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();
  if (data) {
    throw new NotebookToolError(
      'revision_conflict',
      `Notebook was modified concurrently (current revision ${Number(data.revision)})`,
      409
    );
  }
  throw new NotebookToolError('notebook_not_found', 'Notebook not found', 404);
}

async function assertNoteRevisionConflict(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  noteId: string
): Promise<never> {
  const { data } = await supabase
    .from('notebook_notes')
    .select('revision')
    .eq('id', noteId)
    .eq('notebook_id', notebookId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();
  if (data) {
    throw new NotebookToolError(
      'revision_conflict',
      `Note was modified concurrently (current revision ${Number(data.revision)})`,
      409
    );
  }
  throw new NotebookToolError('note_not_found', 'Note not found', 404);
}

// Applies a mutation to a note's image asset list. Reads the current row,
// lets `mutate` produce the next list, then writes it back with a CAS on the
// revision that was just read -- concurrent editors surface as
// revision_conflict instead of silently losing an attach/detach. The revision
// bump also lands in note_change_log, which advances the notebook's pack
// sha256 so devices re-sync the image_ids automatically.
async function mutateNoteAssets(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  noteId: string,
  mutate: (assets: NoteImageAsset[]) => NoteImageAsset[]
): Promise<NoteRecord> {
  const notebook = await requireNotebookOwner(supabase, userId, notebookId);

  const { data: current, error: readError } = await supabase
    .from('notebook_notes')
    .select(NOTE_COLUMNS)
    .eq('id', noteId)
    .eq('notebook_id', notebookId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();
  if (readError) {
    throw new NotebookToolError('database_error', readError.message, 500);
  }
  if (!current) {
    throw new NotebookToolError('note_not_found', 'Note not found', 404);
  }

  const revision = Number(current.revision ?? 1);
  const currentAssets = mapNoteAssets(current.assets);
  const nextAssets = mutate(currentAssets);
  if (nextAssets.length > NOTE_IMAGE_MAX_PER_NOTE) {
    throw new NotebookToolError(
      'invalid_request',
      `A note can hold at most ${NOTE_IMAGE_MAX_PER_NOTE} images`,
      400
    );
  }

  // A duplicate attach is a real idempotent replay. Do not manufacture a
  // revision/change-log entry (and a device pack refresh) when the asset list
  // is byte-for-byte unchanged.
  if (JSON.stringify(nextAssets) === JSON.stringify(currentAssets)) {
    return mapNote(current, notebook.subject_id);
  }

  const { data, error } = await supabase
    .from('notebook_notes')
    .update({ assets: nextAssets as unknown as Json, revision: revision + 1 })
    .eq('id', noteId)
    .eq('notebook_id', notebookId)
    .eq('user_id', userId)
    .eq('revision', revision)
    .is('archived_at', null)
    .select(NOTE_COLUMNS)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data) {
    await assertNoteRevisionConflict(supabase, userId, notebookId, noteId);
  }
  return mapNote(data, notebook.subject_id);
}

export async function attachNoteImageAsset(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  noteId: string,
  asset: NoteImageAsset
): Promise<NoteRecord> {
  return mutateNoteAssets(supabase, userId, notebookId, noteId, assets => {
    const existingIndex = assets.findIndex(
      existing => existing.image_id === asset.image_id
    );
    if (existingIndex < 0) {
      return [...assets, asset];
    }
    if (JSON.stringify(assets[existingIndex]) === JSON.stringify(asset)) {
      // Exact idempotent replay: do not manufacture a note revision.
      return assets;
    }
    // The BW1 content ID can remain stable while a newer pipeline changes
    // preview/GRAY4 artifacts. Refresh the asset record in place.
    const refreshed = [...assets];
    refreshed[existingIndex] = asset;
    return refreshed;
  });
}

export async function detachNoteImageAsset(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string,
  noteId: string,
  imageId: string
): Promise<{ note: NoteRecord; removed: NoteImageAsset }> {
  let removed: NoteImageAsset | null = null;
  const note = await mutateNoteAssets(
    supabase,
    userId,
    notebookId,
    noteId,
    assets => {
      removed = assets.find(asset => asset.image_id === imageId) ?? null;
      if (!removed) {
        throw new NotebookToolError('note_not_found', 'Image not found', 404);
      }
      return assets.filter(asset => asset.image_id !== imageId);
    }
  );
  return { note, removed: removed! };
}

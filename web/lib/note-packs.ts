import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotebookToolError } from './notebooks';
import { NOTE_PACK_SCHEMA_VERSION } from './note-study-v1';

// Deterministic per-notebook note packs. There is no separate note_packs table:
// a pack is computed on demand from the notebook's active notes. The manifest,
// the pack-download route, and the session snapshot all call buildNotePack so
// their SHA-256 values agree for the same content state.

export interface NotePackNote {
  note_id: string;
  notebook_id: string;
  sort_index: number;
  revision: number;
  title: string;
  content: string;
  /** SHA-256 ids of the note's e-ink images (WQNI files), display order. */
  image_ids: string[];
}

export interface NotePackResult {
  notebook_id: string;
  content_revision: number;
  pack_revision: number;
  sha256: string;
  entry_count: number;
  byte_size: number;
  body: string;
}

/**
 * A notebook's content revision is the highest note change_seq recorded for it,
 * which advances whenever any note is created/updated/archived/deleted. It is
 * 0 for a notebook with no note history.
 */
export async function computeNotebookContentRevision(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string
): Promise<number> {
  const { data, error } = await supabase
    .from('note_change_log')
    .select('change_seq')
    .eq('user_id', userId)
    .eq('notebook_id', notebookId)
    .order('change_seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new NotebookToolError('database_error', error.message, 500);
  }
  return Number(data?.change_seq ?? 0);
}

export async function buildNotePack(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string
): Promise<NotePackResult> {
  const contentRevision = await computeNotebookContentRevision(
    supabase,
    userId,
    notebookId
  );

  const { data, error } = await supabase
    .from('notebook_notes')
    .select('id, notebook_id, sort_index, revision, title, content, assets')
    .eq('notebook_id', notebookId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('sort_index', { ascending: true })
    .order('id', { ascending: true });
  if (error) {
    throw new NotebookToolError('database_error', error.message, 500);
  }

  const notes: NotePackNote[] = (data || []).map((row: any) => ({
    note_id: row.id,
    notebook_id: row.notebook_id,
    sort_index: Number(row.sort_index ?? 0),
    revision: Number(row.revision ?? 1),
    title: row.title,
    content: row.content,
    image_ids: Array.isArray(row.assets)
      ? row.assets
          .map((asset: any) =>
            typeof asset?.image_id === 'string' ? asset.image_id : null
          )
          .filter((id: string | null): id is string => id !== null)
      : [],
  }));

  // NOTE_PACK_V1: a metadata line followed by one JSONL record per note. The
  // fixed key order keeps the bytes (and therefore the SHA) stable. image_ids
  // is always present (empty array for image-less notes) so the byte layout
  // stays deterministic; the device parser ignores keys it does not know.
  const lines = [
    JSON.stringify({
      v: NOTE_PACK_SCHEMA_VERSION,
      notebook_id: notebookId,
      content_revision: contentRevision,
      count: notes.length,
    }),
    ...notes.map(note =>
      JSON.stringify({
        note_id: note.note_id,
        notebook_id: note.notebook_id,
        sort_index: note.sort_index,
        revision: note.revision,
        title: note.title,
        content: note.content,
        image_ids: note.image_ids,
      })
    ),
  ];
  const body = lines.join('\n');
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');

  return {
    notebook_id: notebookId,
    content_revision: contentRevision,
    pack_revision: contentRevision,
    sha256,
    entry_count: notes.length,
    byte_size: Buffer.byteLength(body, 'utf8'),
    body,
  };
}

export interface NoteManifestData {
  cursor: string;
  has_more: boolean;
  notebooks: Array<{
    notebook_id: string;
    title: string;
    change_sequence: number;
    content_revision: number;
    deleted: boolean;
    pack: {
      pack_id: string;
      pack_revision: number;
      schema_version: number;
      format: 'jsonl';
      compression: 'zlib';
      entry_count: number;
      byte_size: number;
      sha256: string;
      download_url: string;
    } | null;
  }>;
}

/**
 * Lists the caller's active notebooks (ordered by id) with a deterministic pack
 * summary each. Paginated by an integer offset cursor. The device downloads a
 * pack from /api/esp32/v3/notes/packs/{notebook_id}; pack_id is the notebook id
 * because a pack is exactly one notebook's note set.
 */
export async function loadNoteStudyManifest(
  supabase: SupabaseClient<any>,
  userId: string,
  origin: string,
  cursor: number,
  limit = 50
): Promise<NoteManifestData> {
  const pageSize = Math.min(Math.max(limit, 1), 100);
  const { data, error } = await supabase
    .from('notebooks')
    .select('id, title')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('id', { ascending: true })
    .range(cursor, cursor + pageSize);
  if (error) {
    throw new NotebookToolError('database_error', error.message, 500);
  }

  const rows = (data || []) as Array<{ id: string; title: string }>;
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);

  const notebooks = await Promise.all(
    page.map(async row => {
      const pack = await buildNotePack(supabase, userId, row.id);
      return {
        notebook_id: row.id,
        title: row.title,
        change_sequence: pack.content_revision,
        content_revision: pack.content_revision,
        deleted: false,
        pack: {
          pack_id: row.id,
          pack_revision: pack.pack_revision,
          schema_version: NOTE_PACK_SCHEMA_VERSION,
          format: 'jsonl' as const,
          compression: 'zlib' as const,
          entry_count: pack.entry_count,
          byte_size: pack.byte_size,
          sha256: pack.sha256,
          download_url: `${origin}/api/esp32/v3/notes/packs/${row.id}`,
        },
      };
    })
  );

  return {
    cursor: String(cursor + page.length),
    has_more: hasMore,
    notebooks,
  };
}

export async function getDownloadableNotePack(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookId: string
): Promise<{
  pack: { id: string; revision: number; sha256: string; byte_size: number };
  notebook: { id: string; title: string };
  body: string;
}> {
  const { data: notebook, error } = await supabase
    .from('notebooks')
    .select('id, title')
    .eq('id', notebookId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();
  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!notebook) {
    throw new NotebookToolError(
      'notebook_not_found',
      'Notebook not found',
      404
    );
  }

  const pack = await buildNotePack(supabase, userId, notebookId);
  return {
    pack: {
      id: notebookId,
      revision: pack.pack_revision,
      sha256: pack.sha256,
      byte_size: pack.byte_size,
    },
    notebook: { id: notebook.id, title: notebook.title },
    body: pack.body,
  };
}

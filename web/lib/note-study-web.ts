import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from './database.types';
import { logger } from './logger';
import {
  noteStudyModeSchema,
  noteStudySessionItemSchema,
  type NoteStudyMode,
} from './note-study-v1';

const sessionStatusSchema = z.enum([
  'active',
  'paused',
  'completed',
  'abandoned',
]);
const sessionItemsSchema = z.array(noteStudySessionItemSchema).max(500);

export type WebNoteSessionStatus = z.infer<typeof sessionStatusSchema>;

export interface NoteReadStateView {
  state: 'unread' | 'reading' | 'completed';
  last_opened_at: string | null;
  last_completed_at: string | null;
  completed_count: number;
}

export interface NotebookReadSummary {
  notebook_id: string;
  total: number;
  unread_count: number;
  reading_count: number;
  completed_count: number;
  last_opened_at: string | null;
  last_note_id: string | null;
  last_note_title: string | null;
  resumable_session_id: string | null;
  resume_note_id: string | null;
  resume_note_title: string | null;
}

export interface RecentNoteRead {
  note_id: string;
  notebook_id: string;
  notebook_title: string;
  note_title: string;
  state: NoteReadStateView['state'];
  last_opened_at: string;
  last_completed_at: string | null;
  completed_count: number;
  actor: 'web' | 'note4' | 'unknown';
}

export interface WebNoteStudyItem {
  available: boolean;
  item_id: string;
  notebook_id: string;
  notebook_title: string;
  ordinal: number;
  title: string;
  content: string;
  content_format: string;
  source: string;
  assets: Array<{
    path: string;
    image_id: string;
    display_path: string;
    preview_path: string;
  }>;
  revision: number;
  linked_problem: {
    problem_id: string;
    problem_set_id: string | null;
    subject_id: string;
    title: string;
    status: string;
  } | null;
  read_state: NoteReadStateView;
}

export interface WebNoteStudySessionSummary {
  session_id: string;
  mode: NoteStudyMode;
  status: WebNoteSessionStatus;
  notebook_ids: string[];
  notebook_titles: string[];
  candidate_count: number;
  next_sequence: number;
  started_at: string;
  last_activity_at: string;
  expires_at: string;
  device_id: string | null;
  current_note_id: string | null;
  current_note_title: string | null;
}

export interface WebNoteStudySessionView extends WebNoteStudySessionSummary {
  current_item: WebNoteStudyItem | null;
  result: {
    opened_count: number;
    completed_count: number;
    skipped_count: number;
  };
}

export class WebNoteStudyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'WebNoteStudyError';
  }
}

function databaseError(action: string, error: unknown): never {
  logger.error('Web Note study database operation failed', error, {
    component: 'WebNoteStudy',
    action,
  });
  throw new WebNoteStudyError(
    'NOTE_STUDY_UNAVAILABLE',
    'Note reading service unavailable',
    503,
    true
  );
}

function parseScope(value: unknown): {
  notebook_ids: string[];
  include_archived: boolean;
} {
  const parsed = z
    .object({
      notebook_ids: z.array(z.uuid()).max(32),
      include_archived: z.boolean(),
    })
    .safeParse(value);
  if (!parsed.success) {
    throw new WebNoteStudyError(
      'NOTE_SESSION_SNAPSHOT_INVALID',
      'Note reading session scope is invalid',
      409
    );
  }
  return parsed.data;
}

function mapReadState(row: any): NoteReadStateView {
  const lastOpened = row?.last_opened_at || null;
  const lastCompleted = row?.last_completed_at || null;
  return {
    state: lastCompleted ? 'completed' : lastOpened ? 'reading' : 'unread',
    last_opened_at: lastOpened,
    last_completed_at: lastCompleted,
    completed_count: Number(row?.completed_count || 0),
  };
}

async function loadNotebookTitles(
  supabase: SupabaseClient<any>,
  notebookIds: string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(notebookIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('notebooks')
    .select('id, title')
    .in('id', ids);
  if (error) databaseError('loadNotebookTitles', error);
  return new Map((data || []).map((row: any) => [row.id, row.title]));
}

function summaryFromRow(
  row: Database['public']['Tables']['study_sessions']['Row'],
  notebookTitles: Map<string, string>,
  current?: { id: string; title: string } | null
): WebNoteStudySessionSummary {
  const scope = parseScope(row.scope);
  return {
    session_id: row.id,
    mode: noteStudyModeSchema.parse(row.mode),
    status: sessionStatusSchema.parse(row.status),
    notebook_ids: scope.notebook_ids,
    notebook_titles: scope.notebook_ids.map(
      id => notebookTitles.get(id) || '已移除笔记本'
    ),
    candidate_count: Number(row.candidate_count),
    next_sequence: Number(row.next_sequence),
    started_at: row.started_at,
    last_activity_at: row.last_activity_at,
    expires_at: row.expires_at,
    device_id: row.device_id,
    current_note_id: current?.id || null,
    current_note_title: current?.title || null,
  };
}

function parseSessionItems(row: {
  candidate_items: Database['public']['Tables']['study_sessions']['Row']['candidate_items'];
  candidate_count: number;
}) {
  const parsed = sessionItemsSchema.safeParse(row.candidate_items);
  if (
    !parsed.success ||
    parsed.data.length !== Number(row.candidate_count) ||
    parsed.data.some((item, index) => item.ordinal !== index)
  ) {
    throw new WebNoteStudyError(
      'NOTE_SESSION_SNAPSHOT_INVALID',
      'Note reading candidate snapshot is incomplete',
      409
    );
  }
  return parsed.data;
}

export async function loadResumableWebNoteStudySessions(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: { notebook_id?: string; limit?: number } = {}
): Promise<WebNoteStudySessionSummary[]> {
  const { data, error } = await supabase
    .from('study_sessions')
    .select('*')
    .eq('user_id', userId)
    .is('device_id', null)
    .eq('domain', 'note')
    .in('status', ['active', 'paused'])
    .gt('expires_at', new Date().toISOString())
    .order('last_activity_at', { ascending: false })
    .limit(Math.min(Math.max(options.limit || 12, 1), 30));
  if (error) databaseError('loadResumableSessions', error);

  const filtered = (data || []).filter(row => {
    const scope = parseScope(row.scope);
    return (
      !options.notebook_id || scope.notebook_ids.includes(options.notebook_id)
    );
  });
  const allNotebookIds = filtered.flatMap(
    row => parseScope(row.scope).notebook_ids
  );
  const titles = await loadNotebookTitles(supabase, allNotebookIds);
  const currentIds = filtered.flatMap(row => {
    const items = parseSessionItems(row);
    const current = items[Number(row.next_sequence)];
    return current ? [current.item_id] : [];
  });
  const currentRows = new Map<string, { id: string; title: string }>();
  if (currentIds.length) {
    const { data: notes, error: noteError } = await (
      supabase as SupabaseClient<any>
    )
      .from('notebook_notes')
      .select('id, title')
      .in('id', [...new Set(currentIds)])
      .is('archived_at', null);
    if (noteError)
      databaseError('loadResumableSessions.currentNotes', noteError);
    for (const note of notes || []) currentRows.set(note.id, note);
  }

  return filtered.map(row => {
    const current = parseSessionItems(row)[Number(row.next_sequence)];
    return summaryFromRow(
      row,
      titles,
      current ? currentRows.get(current.item_id) || null : null
    );
  });
}

export async function loadNotebookReadSummaries(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookIds: string[]
): Promise<Record<string, NotebookReadSummary>> {
  const ids = [...new Set(notebookIds)].filter(Boolean);
  const result: Record<string, NotebookReadSummary> = Object.fromEntries(
    ids.map(id => [
      id,
      {
        notebook_id: id,
        total: 0,
        unread_count: 0,
        reading_count: 0,
        completed_count: 0,
        last_opened_at: null,
        last_note_id: null,
        last_note_title: null,
        resumable_session_id: null,
        resume_note_id: null,
        resume_note_title: null,
      } satisfies NotebookReadSummary,
    ])
  );
  if (!ids.length) return result;

  const { data: notes, error: noteError } = await (
    supabase as SupabaseClient<any>
  )
    .from('notebook_notes')
    .select('id, notebook_id, title')
    .eq('user_id', userId)
    .in('notebook_id', ids)
    .is('archived_at', null);
  if (noteError) databaseError('loadNotebookReadSummaries.notes', noteError);

  const noteIds = (notes || []).map((row: any) => row.id);
  const stateByNote = new Map<string, any>();
  for (let offset = 0; offset < noteIds.length; offset += 200) {
    const { data, error } = await (supabase as SupabaseClient<any>)
      .from('note_read_state')
      .select(
        'note_id, last_opened_at, last_completed_at, completed_count, updated_at'
      )
      .eq('user_id', userId)
      .in('note_id', noteIds.slice(offset, offset + 200));
    if (error) databaseError('loadNotebookReadSummaries.states', error);
    for (const row of data || []) stateByNote.set(row.note_id, row);
  }

  for (const note of notes || []) {
    const summary = result[note.notebook_id];
    if (!summary) continue;
    const state = mapReadState(stateByNote.get(note.id));
    summary.total += 1;
    if (state.state === 'completed') summary.completed_count += 1;
    else if (state.state === 'reading') summary.reading_count += 1;
    else summary.unread_count += 1;
    if (
      state.last_opened_at &&
      (!summary.last_opened_at ||
        Date.parse(state.last_opened_at) > Date.parse(summary.last_opened_at))
    ) {
      summary.last_opened_at = state.last_opened_at;
      summary.last_note_id = note.id;
      summary.last_note_title = note.title;
    }
  }

  const sessions = await loadResumableWebNoteStudySessions(supabase, userId, {
    limit: 30,
  });
  for (const session of sessions) {
    for (const notebookId of session.notebook_ids) {
      const summary = result[notebookId];
      if (summary && !summary.resumable_session_id) {
        summary.resumable_session_id = session.session_id;
        summary.resume_note_id = session.current_note_id;
        summary.resume_note_title = session.current_note_title;
      }
    }
  }
  return result;
}

export async function loadRecentNoteReads(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: { notebook_id?: string; limit?: number } = {}
): Promise<RecentNoteRead[]> {
  const limit = Math.min(Math.max(options.limit || 12, 1), 40);
  let noteQuery = (supabase as SupabaseClient<any>)
    .from('notebook_notes')
    .select('id, notebook_id, title, notebooks(title)')
    .eq('user_id', userId)
    .is('archived_at', null);
  if (options.notebook_id) {
    noteQuery = noteQuery.eq('notebook_id', options.notebook_id);
  }
  const { data: notes, error: noteError } = await noteQuery.limit(1000);
  if (noteError) databaseError('loadRecentReads.notes', noteError);
  const noteById = new Map((notes || []).map((row: any) => [row.id, row]));
  if (!noteById.size) return [];

  const { data: states, error: stateError } = await (
    supabase as SupabaseClient<any>
  )
    .from('note_read_state')
    .select('note_id, last_opened_at, last_completed_at, completed_count')
    .eq('user_id', userId)
    .in('note_id', [...noteById.keys()])
    .not('last_opened_at', 'is', null)
    .order('last_opened_at', { ascending: false })
    .limit(limit);
  if (stateError) databaseError('loadRecentReads.states', stateError);

  const stateIds = (states || []).map((row: any) => row.note_id);
  const actorByNote = new Map<string, RecentNoteRead['actor']>();
  if (stateIds.length) {
    const { data: observations, error } = await (
      supabase as SupabaseClient<any>
    )
      .from('study_observations')
      .select('item_id, device_id, occurred_at')
      .eq('user_id', userId)
      .in('item_id', stateIds)
      .in('action', ['opened', 'read_completed'])
      .order('occurred_at', { ascending: false })
      .limit(Math.max(limit * 4, 40));
    if (error) databaseError('loadRecentReads.actors', error);
    for (const row of observations || []) {
      if (!actorByNote.has(row.item_id)) {
        actorByNote.set(row.item_id, row.device_id ? 'note4' : 'web');
      }
    }
  }

  return (states || []).flatMap((row: any) => {
    const note = noteById.get(row.note_id);
    if (!note || !row.last_opened_at) return [];
    const readState = mapReadState(row);
    return [
      {
        note_id: note.id,
        notebook_id: note.notebook_id,
        notebook_title: note.notebooks?.title || '笔记本',
        note_title: note.title,
        state: readState.state,
        last_opened_at: row.last_opened_at,
        last_completed_at: row.last_completed_at || null,
        completed_count: Number(row.completed_count || 0),
        actor: actorByNote.get(note.id) || 'unknown',
      } satisfies RecentNoteRead,
    ];
  });
}

function mapAssets(value: unknown): WebNoteStudyItem['assets'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as any).path !== 'string' ||
      typeof (entry as any).image_id !== 'string'
    ) {
      return [];
    }
    return [
      {
        path: (entry as any).path,
        image_id: (entry as any).image_id,
        display_path: String(
          (entry as any).display_path || (entry as any).path
        ),
        preview_path: String(
          (entry as any).preview_path || (entry as any).path
        ),
      },
    ];
  });
}

export async function loadWebNoteStudySession(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string
): Promise<WebNoteStudySessionView> {
  const { data: session, error } = await supabase
    .from('study_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('device_id', null)
    .eq('domain', 'note')
    .maybeSingle();
  if (error) databaseError('loadSession', error);
  if (!session) {
    throw new WebNoteStudyError(
      'SESSION_NOT_FOUND',
      'Note reading session was not found',
      404
    );
  }

  const items = parseSessionItems(session);
  const scope = parseScope(session.scope);
  const notebookTitles = await loadNotebookTitles(supabase, scope.notebook_ids);
  const current = items[Number(session.next_sequence)] || null;
  let currentItem: WebNoteStudyItem | null = null;
  if (current) {
    const { data: note, error: noteError } = await (
      supabase as SupabaseClient<any>
    )
      .from('notebook_notes')
      .select(
        'id, notebook_id, title, content, content_format, source, assets, revision, linked_problem_id'
      )
      .eq('id', current.item_id)
      .eq('user_id', userId)
      .is('archived_at', null)
      .maybeSingle();
    if (noteError) databaseError('loadSession.currentNote', noteError);

    if (!note) {
      currentItem = {
        available: false,
        item_id: current.item_id,
        notebook_id: current.notebook_id,
        notebook_title:
          notebookTitles.get(current.notebook_id) || '已移除笔记本',
        ordinal: current.ordinal,
        title: '笔记已移除',
        content: '这篇笔记在阅读会话创建后被删除或归档。跳过后可继续。',
        content_format: 'plain_text_v1',
        source: 'user',
        assets: [],
        revision: 0,
        linked_problem: null,
        read_state: mapReadState(null),
      };
    } else {
      const { data: state, error: stateError } = await (
        supabase as SupabaseClient<any>
      )
        .from('note_read_state')
        .select('last_opened_at, last_completed_at, completed_count')
        .eq('user_id', userId)
        .eq('note_id', note.id)
        .maybeSingle();
      if (stateError) databaseError('loadSession.readState', stateError);

      let linkedProblem: WebNoteStudyItem['linked_problem'] = null;
      if (note.linked_problem_id) {
        const [
          { data: problem, error: problemError },
          { data: links, error: linkError },
        ] = await Promise.all([
          (supabase as SupabaseClient<any>)
            .from('problems')
            .select('id, title, status, subject_id')
            .eq('id', note.linked_problem_id)
            .eq('user_id', userId)
            .maybeSingle(),
          (supabase as SupabaseClient<any>)
            .from('problem_set_problems')
            .select('problem_set_id')
            .eq('problem_id', note.linked_problem_id)
            .limit(1),
        ]);
        if (problemError || linkError) {
          databaseError('loadSession.linkedProblem', problemError || linkError);
        }
        if (problem) {
          linkedProblem = {
            problem_id: problem.id,
            problem_set_id: links?.[0]?.problem_set_id || null,
            subject_id: problem.subject_id,
            title: problem.title,
            status: problem.status,
          };
        }
      }
      currentItem = {
        available: true,
        item_id: current.item_id,
        notebook_id: note.notebook_id,
        notebook_title: notebookTitles.get(note.notebook_id) || '已移除笔记本',
        ordinal: current.ordinal,
        title: note.title,
        content: note.content,
        content_format: note.content_format || 'plain_text_v1',
        source: note.source,
        assets: mapAssets(note.assets),
        revision: Number(note.revision || 1),
        linked_problem: linkedProblem,
        read_state: mapReadState(state),
      };
    }
  }

  const { data: observations, error: observationError } = await (
    supabase as SupabaseClient<any>
  )
    .from('study_observations')
    .select('action')
    .eq('user_id', userId)
    .eq('session_id', sessionId);
  if (observationError)
    databaseError('loadSession.observations', observationError);
  const result = {
    opened_count: 0,
    completed_count: 0,
    skipped_count: 0,
  };
  for (const observation of observations || []) {
    if (observation.action === 'opened') result.opened_count += 1;
    else if (observation.action === 'read_completed') {
      result.completed_count += 1;
    } else if (observation.action === 'skipped') result.skipped_count += 1;
  }
  return {
    ...summaryFromRow(
      session,
      notebookTitles,
      currentItem ? { id: currentItem.item_id, title: currentItem.title } : null
    ),
    current_item: currentItem,
    result,
  };
}

export async function setWebNoteStudySessionStatus(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string,
  status: WebNoteSessionStatus
): Promise<WebNoteStudySessionSummary> {
  const { data, error } = await supabase.rpc(
    'set_web_note_study_session_status_v1',
    {
      p_user_id: userId,
      p_session_id: sessionId,
      p_status: status,
    }
  );
  if (error) {
    const message = String(error.message || '');
    const known: Array<[string, string, string]> = [
      ['WEB_NOTE_SESSION_NOT_FOUND', 'SESSION_NOT_FOUND', '会话不存在'],
      ['WEB_NOTE_SESSION_EXPIRED', 'SESSION_EXPIRED', '会话已过期'],
      ['WEB_NOTE_SESSION_COMPLETED', 'SESSION_COMPLETED', '会话已完成'],
      ['WEB_NOTE_SESSION_ABANDONED', 'SESSION_ABANDONED', '会话已结束'],
      ['WEB_NOTE_SESSION_INCOMPLETE', 'SESSION_INCOMPLETE', '仍有笔记未确认'],
    ];
    const match = known.find(([needle]) => message.includes(needle));
    if (match) throw new WebNoteStudyError(match[1], match[2], 409);
    databaseError('setSessionStatus', error);
  }
  const row = data as Database['public']['Tables']['study_sessions']['Row'];
  const scope = parseScope(row.scope);
  const titles = await loadNotebookTitles(supabase, scope.notebook_ids);
  return summaryFromRow(row, titles);
}

export function normalizeWebNoteStudyError(error: unknown): {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
} {
  if (error instanceof WebNoteStudyError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
    };
  }
  if (
    error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'NoteStudyServiceError' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    const serviceError = error as {
      code: string;
      message?: string;
      status: number;
      retryable?: boolean;
    };
    return {
      code: serviceError.code,
      message: serviceError.message || 'Note reading request failed',
      status: serviceError.status,
      retryable: Boolean(serviceError.retryable),
    };
  }
  logger.error('Unexpected Web Note study error', error, {
    component: 'WebNoteStudy',
  });
  return {
    code: 'NOTE_STUDY_UNAVAILABLE',
    message: 'Note reading service unavailable',
    status: 503,
    retryable: true,
  };
}

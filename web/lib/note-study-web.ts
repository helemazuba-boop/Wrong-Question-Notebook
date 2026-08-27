import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from './database.types';
import { logger } from './logger';
import {
  noteObservationDataSchema,
  noteStudyModeSchema,
  noteStudySessionItemSchema,
  type NoteStudyMode,
} from './note-study-v1';
import { mapObservationRpcError } from './note-study-service';

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

const webNoteReadStateSchema = z.strictObject({
  state: z.enum(['unread', 'reading', 'completed']),
  last_opened_at: z.string().datetime({ offset: true }).nullable(),
  last_completed_at: z.string().datetime({ offset: true }).nullable(),
  completed_count: z.number().int().nonnegative(),
});

const webNoteStudyItemSchema = z.strictObject({
  available: z.boolean(),
  item_id: z.uuid(),
  notebook_id: z.uuid(),
  notebook_title: z.string(),
  ordinal: z.number().int().nonnegative(),
  title: z.string(),
  content: z.string(),
  content_format: z.string(),
  source: z.string(),
  assets: z.array(
    z.strictObject({
      path: z.string(),
      image_id: z.string(),
      display_path: z.string(),
      preview_path: z.string(),
    })
  ),
  revision: z.number().int().nonnegative(),
  linked_problem: z
    .strictObject({
      problem_id: z.uuid(),
      problem_set_id: z.uuid().nullable(),
      subject_id: z.uuid(),
      title: z.string(),
      status: z.string(),
    })
    .nullable(),
  read_state: webNoteReadStateSchema,
});

const webNoteStudySessionViewSchema = z.strictObject({
  session_id: z.uuid(),
  mode: noteStudyModeSchema,
  status: sessionStatusSchema,
  notebook_ids: z.array(z.uuid()).max(32),
  notebook_titles: z.array(z.string()).max(32),
  candidate_count: z.number().int().nonnegative().max(500),
  next_sequence: z.number().int().nonnegative(),
  started_at: z.string().datetime({ offset: true }),
  last_activity_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
  device_id: z.uuid().nullable(),
  current_note_id: z.uuid().nullable(),
  current_note_title: z.string().nullable(),
  current_item: webNoteStudyItemSchema.nullable(),
  result: z.strictObject({
    opened_count: z.number().int().nonnegative(),
    completed_count: z.number().int().nonnegative(),
    skipped_count: z.number().int().nonnegative(),
  }),
});

const webNoteObservationAdvanceSchema = z.strictObject({
  observation: noteObservationDataSchema,
  session: webNoteStudySessionViewSchema,
});

const recentNoteReadsSchema = z.array(
  z.strictObject({
    note_id: z.uuid(),
    notebook_id: z.uuid(),
    notebook_title: z.string(),
    note_title: z.string(),
    state: z.enum(['unread', 'reading', 'completed']),
    last_opened_at: z.string().datetime({ offset: true }),
    last_completed_at: z.string().datetime({ offset: true }).nullable(),
    completed_count: z.number().int().nonnegative(),
    actor: z.enum(['web', 'note4', 'unknown']),
  })
);

export type WebNoteObservationAdvance = z.infer<
  typeof webNoteObservationAdvanceSchema
>;

export interface WebNoteObservationInput {
  request_id: string;
  session_id: string;
  sequence: number;
  item_id: string;
  action: 'opened' | 'read_completed' | 'skipped';
  mode: NoteStudyMode;
  occurred_at: string;
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
  userId: string,
  notebookIds: string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(notebookIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('notebooks')
    .select('id, title')
    .eq('user_id', userId)
    .in('id', ids);
  if (error) databaseError('loadNotebookTitles', error);
  return new Map((data || []).map((row: any) => [row.id, row.title]));
}

function summaryFromRow(
  row: Database['public']['Tables']['study_sessions']['Row'],
  notebookTitles: Map<string, string>,
  current?: { id: string; title: string } | null,
  parsedScope?: { notebook_ids: string[]; include_archived: boolean }
): WebNoteStudySessionSummary {
  const scope = parsedScope ?? parseScope(row.scope);
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

  const filtered = (data || [])
    .map(row => ({
      row,
      scope: parseScope(row.scope),
      items: parseSessionItems(row),
    }))
    .filter(
      entry =>
        !options.notebook_id ||
        entry.scope.notebook_ids.includes(options.notebook_id)
    );
  const allNotebookIds = filtered.flatMap(entry => entry.scope.notebook_ids);
  const currentIds = filtered.flatMap(({ row, items }) => {
    const current = items[Number(row.next_sequence)];
    return current ? [current.item_id] : [];
  });
  const currentRows = new Map<string, { id: string; title: string }>();
  const currentNotesPromise = currentIds.length
    ? (supabase as SupabaseClient<any>)
        .from('notebook_notes')
        .select('id, title')
        .eq('user_id', userId)
        .in('id', [...new Set(currentIds)])
        .is('archived_at', null)
    : Promise.resolve({ data: [], error: null });
  const [titles, { data: notes, error: noteError }] = await Promise.all([
    loadNotebookTitles(supabase, userId, allNotebookIds),
    currentNotesPromise,
  ]);
  if (noteError) databaseError('loadResumableSessions.currentNotes', noteError);
  for (const note of notes || []) currentRows.set(note.id, note);

  return filtered.map(({ row, scope, items }) => {
    const current = items[Number(row.next_sequence)];
    return summaryFromRow(
      row,
      titles,
      current ? currentRows.get(current.item_id) || null : null,
      scope
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

  const sessionsPromise = loadResumableWebNoteStudySessions(supabase, userId, {
    limit: 30,
  });

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
  const stateChunks: string[][] = [];
  for (let offset = 0; offset < noteIds.length; offset += 200) {
    stateChunks.push(noteIds.slice(offset, offset + 200));
  }
  const [stateResults, sessions] = await Promise.all([
    Promise.all(
      stateChunks.map(noteIdChunk =>
        (supabase as SupabaseClient<any>)
          .from('note_read_state')
          .select(
            'note_id, last_opened_at, last_completed_at, completed_count, updated_at'
          )
          .eq('user_id', userId)
          .in('note_id', noteIdChunk)
      )
    ),
    sessionsPromise,
  ]);
  for (const { data, error } of stateResults) {
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
  const { data, error } = await supabase.rpc('get_recent_note_reads_v2', {
    p_user_id: userId,
    p_notebook_id: options.notebook_id ?? null,
    p_limit: limit,
  });
  if (error) databaseError('loadRecentReads', error);
  const parsed = recentNoteReadsSchema.safeParse(data || []);
  if (!parsed.success) {
    logger.error(
      'Recent Note reads RPC returned an invalid result',
      parsed.error,
      {
        component: 'WebNoteStudy',
        action: 'loadRecentReads.parse',
      }
    );
    throw new WebNoteStudyError(
      'NOTE_STUDY_UNAVAILABLE',
      'Recent Note reads are unavailable',
      503,
      true
    );
  }
  return parsed.data;
}

export async function loadWebNoteStudySession(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string
): Promise<WebNoteStudySessionView> {
  const { data, error } = await supabase.rpc('get_web_note_study_session_v2', {
    p_user_id: userId,
    p_session_id: sessionId,
  });
  if (error) {
    if (String(error.message || '').includes('WEB_NOTE_SESSION_NOT_FOUND')) {
      throw new WebNoteStudyError(
        'SESSION_NOT_FOUND',
        'Note reading session was not found',
        404
      );
    }
    databaseError('loadSession', error);
  }
  const parsed = webNoteStudySessionViewSchema.safeParse(data);
  if (!parsed.success) {
    logger.error(
      'Web Note session RPC returned an invalid result',
      parsed.error,
      {
        component: 'WebNoteStudy',
        action: 'loadSession.parse',
        sessionId,
      }
    );
    throw new WebNoteStudyError(
      'NOTE_SESSION_SNAPSHOT_INVALID',
      'Note reading session snapshot is invalid',
      409
    );
  }
  return parsed.data;
}

export async function advanceWebNoteStudyObservation(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: WebNoteObservationInput
): Promise<WebNoteObservationAdvance> {
  const { data, error } = await supabase.rpc(
    'record_web_note_study_observation_v2',
    {
      p_user_id: userId,
      p_request_id: input.request_id,
      p_session_id: input.session_id,
      p_sequence: input.sequence,
      p_item_id: input.item_id,
      p_action: input.action,
      p_mode: input.mode,
      p_occurred_at: input.occurred_at,
      p_skip: input.action === 'skipped',
    }
  );
  if (error) mapObservationRpcError('advanceWebNoteStudyObservation', error);

  const parsed = webNoteObservationAdvanceSchema.safeParse(data);
  if (!parsed.success) {
    logger.error(
      'Web Note observation RPC returned an invalid result',
      parsed.error,
      {
        component: 'WebNoteStudy',
        action: 'advanceObservation.parse',
      }
    );
    throw new WebNoteStudyError(
      'INVALID_STUDY_RESULT',
      'Note reading service returned invalid data',
      503,
      true
    );
  }
  return parsed.data;
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
  const titles = await loadNotebookTitles(supabase, userId, scope.notebook_ids);
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

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from './database.types';
import { logger } from './logger';
import { WordStudyServiceError } from './word-study-service';
import {
  wordStudyModeSchema,
  wordStudySessionItemSchema,
  type WordStudyMode,
} from './word-study-v1';
import { WordToolError } from './words';

const webWordSessionStatusSchema = z.enum([
  'active',
  'paused',
  'completed',
  'abandoned',
]);
const sessionItemsSchema = z.array(wordStudySessionItemSchema).max(500);

export type WebWordSessionStatus = z.infer<typeof webWordSessionStatusSchema>;

export interface WebWordStudyEntry {
  available: boolean;
  item_id: string;
  deck_id: string;
  deck_title: string;
  ordinal: number;
  word: string;
  normalized_word: string;
  phonetic: string | null;
  meaning: string;
  example: string | null;
  example_translation: string | null;
  part_of_speech: string | null;
  tags: string[];
  mistake: {
    problem_id: string;
    problem_set_id: string;
    problem_title: string;
    problem_status: string;
  } | null;
  progress: {
    status: 'new' | 'learning' | 'review' | 'mastered';
    due_at: string | null;
    reviewed_count: number;
    known_count: number;
    unknown_count: number;
  };
}

export interface WebWordStudySessionSummary {
  session_id: string;
  mode: WordStudyMode;
  status: WebWordSessionStatus;
  deck_ids: string[];
  deck_titles: string[];
  include_mastered: boolean;
  optional_count: number;
  candidate_count: number;
  next_sequence: number;
  started_at: string;
  last_activity_at: string;
  expires_at: string;
  device_id: string | null;
}

export interface WebWordStudySessionView extends WebWordStudySessionSummary {
  items: WebWordStudyEntry[];
  result: {
    known_count: number;
    unknown_count: number;
    skipped_count: number;
    looked_up_count: number;
  };
}

export interface WordDeckStudySummary {
  deck_id: string;
  total: number;
  new_count: number;
  learning_count: number;
  review_count: number;
  mastered_count: number;
  due_count: number;
}

export interface WebWordProgressOverview {
  totals: Omit<WordDeckStudySummary, 'deck_id'>;
  decks: WordDeckStudySummary[];
  recent_sessions: WebWordStudySessionSummary[];
  recent_activity: Array<{
    item_id: string;
    word: string;
    action: string;
    occurred_at: string;
    device_id: string | null;
  }>;
}

export class WebWordStudyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'WebWordStudyError';
  }
}

function databaseError(action: string, error: unknown): never {
  logger.error('Web Word study database operation failed', error, {
    component: 'WebWordStudy',
    action,
  });
  throw new WebWordStudyError(
    'WORD_STUDY_UNAVAILABLE',
    'Word study service unavailable',
    503,
    true
  );
}

function parseScope(value: unknown): {
  deck_ids: string[];
  include_mastered: boolean;
} {
  const parsed = z
    .object({
      deck_ids: z.array(z.uuid()).max(32),
      include_mastered: z.boolean(),
    })
    .safeParse(value);
  if (!parsed.success) {
    throw new WebWordStudyError(
      'WORD_SESSION_SNAPSHOT_INVALID',
      'Word study session scope is invalid',
      409
    );
  }
  return parsed.data;
}

function normalizeProgressStatus(
  value: unknown
): WebWordStudyEntry['progress']['status'] {
  return value === 'learning' || value === 'review' || value === 'mastered'
    ? value
    : 'new';
}

function summaryFromRow(
  row: Database['public']['Tables']['study_sessions']['Row'],
  deckTitles: Map<string, string>
): WebWordStudySessionSummary {
  const scope = parseScope(row.scope);
  const mode = wordStudyModeSchema.parse(row.mode);
  const status = webWordSessionStatusSchema.parse(row.status);
  return {
    session_id: row.id,
    mode,
    status,
    deck_ids: scope.deck_ids,
    deck_titles: scope.deck_ids.map(
      deckId => deckTitles.get(deckId) || '已移除词库'
    ),
    include_mastered: scope.include_mastered,
    optional_count: Number(row.optional_count || row.candidate_count),
    candidate_count: Number(row.candidate_count),
    next_sequence: Number(row.next_sequence),
    started_at: row.started_at,
    last_activity_at: row.last_activity_at,
    expires_at: row.expires_at,
    device_id: row.device_id,
  };
}

export async function loadWordMistakeLinks(
  supabase: SupabaseClient<Database>,
  userId: string,
  entryIds: string[]
): Promise<
  Map<
    string,
    {
      problem_id: string;
      problem_set_id: string;
      problem_title: string;
      problem_status: string;
    }
  >
> {
  const uniqueIds = [...new Set(entryIds)].filter(Boolean);
  const result = new Map<
    string,
    {
      problem_id: string;
      problem_set_id: string;
      problem_title: string;
      problem_status: string;
    }
  >();
  if (uniqueIds.length === 0) return result;

  const { data, error } = await (supabase as any)
    .from('word_mistake_links')
    .select(
      'word_entry_id, problem_id, problem_set_id, problems(title, status)'
    )
    .eq('user_id', userId)
    .in('word_entry_id', uniqueIds);
  if (error) databaseError('loadWordMistakeLinks', error);
  for (const row of data || []) {
    if (!row?.word_entry_id || !row?.problem_id || !row?.problem_set_id) {
      continue;
    }
    result.set(row.word_entry_id, {
      problem_id: row.problem_id,
      problem_set_id: row.problem_set_id,
      problem_title: row.problems?.title || 'Word 错题',
      problem_status: row.problems?.status || 'wrong',
    });
  }
  return result;
}

async function loadDeckTitles(
  supabase: SupabaseClient<Database>,
  deckIds: string[]
): Promise<Map<string, string>> {
  if (deckIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('word_decks')
    .select('id, title')
    .in('id', [...new Set(deckIds)]);
  if (error) databaseError('loadDeckTitles', error);
  return new Map((data || []).map(deck => [deck.id, deck.title]));
}

export async function loadResumableWebWordStudySessions(
  supabase: SupabaseClient<Database>,
  userId: string,
  limit = 6
): Promise<WebWordStudySessionSummary[]> {
  const { data, error } = await supabase
    .from('study_sessions')
    .select('*')
    .eq('user_id', userId)
    .is('device_id', null)
    .eq('domain', 'word')
    .in('status', ['active', 'paused'])
    .gt('expires_at', new Date().toISOString())
    .order('last_activity_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 20));
  if (error) databaseError('loadResumableSessions', error);

  const rows = data || [];
  const deckIds = rows.flatMap(row => parseScope(row.scope).deck_ids);
  const deckTitles = await loadDeckTitles(supabase, deckIds);
  return rows.map(row => summaryFromRow(row, deckTitles));
}

export async function loadWebWordStudySession(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string
): Promise<WebWordStudySessionView> {
  const { data: session, error: sessionError } = await supabase
    .from('study_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('device_id', null)
    .eq('domain', 'word')
    .maybeSingle();
  if (sessionError) databaseError('loadSession', sessionError);
  if (!session) {
    throw new WebWordStudyError(
      'SESSION_NOT_FOUND',
      'Word study session was not found',
      404
    );
  }

  const parsedItems = sessionItemsSchema.safeParse(session.candidate_items);
  if (!parsedItems.success) {
    throw new WebWordStudyError(
      'WORD_SESSION_SNAPSHOT_INVALID',
      'Word study candidate snapshot is invalid',
      409
    );
  }
  if (
    parsedItems.data.length !== Number(session.candidate_count) ||
    parsedItems.data.some((item, index) => item.ordinal !== index)
  ) {
    throw new WebWordStudyError(
      'WORD_SESSION_SNAPSHOT_INCOMPLETE',
      'Word study candidate snapshot is incomplete',
      409
    );
  }

  const itemIds = parsedItems.data.map(item => item.item_id);
  const scope = parseScope(session.scope);
  const deckTitles = await loadDeckTitles(supabase, scope.deck_ids);
  const entryRows: any[] = [];
  for (let offset = 0; offset < itemIds.length; offset += 100) {
    const chunk = itemIds.slice(offset, offset + 100);
    const { data, error } = await supabase
      .from('word_entries')
      .select(
        'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, word_progress(status, due_at, reviewed_count, known_count, unknown_count, user_id)'
      )
      .in('id', chunk)
      .eq('word_progress.user_id', userId);
    if (error) databaseError('loadSession.entries', error);
    entryRows.push(...(data || []));
  }

  const entryById = new Map(entryRows.map(row => [row.id, row]));
  const mistakeByEntryId = await loadWordMistakeLinks(
    supabase,
    userId,
    itemIds
  );
  const items = parsedItems.data.map(item => {
    const row = entryById.get(item.item_id);
    if (!row) {
      return {
        available: false,
        item_id: item.item_id,
        deck_id: item.deck_id,
        deck_title: deckTitles.get(item.deck_id) || '已移除词库',
        ordinal: item.ordinal,
        word: '词条已移除',
        normalized_word: '',
        phonetic: null,
        meaning: '该词条在会话创建后被移除。跳过后可以继续其余学习内容。',
        example: null,
        example_translation: null,
        part_of_speech: null,
        tags: [],
        mistake: null,
        progress: {
          status: 'new',
          due_at: null,
          reviewed_count: 0,
          known_count: 0,
          unknown_count: 0,
        },
      } satisfies WebWordStudyEntry;
    }
    const progress = Array.isArray(row.word_progress)
      ? row.word_progress[0]
      : row.word_progress;
    return {
      available: true,
      item_id: item.item_id,
      deck_id: item.deck_id,
      deck_title: deckTitles.get(item.deck_id) || '已移除词库',
      ordinal: item.ordinal,
      word: row.word,
      normalized_word: row.normalized_word,
      phonetic: row.phonetic,
      meaning: row.meaning,
      example: row.example,
      example_translation: row.example_translation,
      part_of_speech: row.part_of_speech,
      tags: Array.isArray(row.tags) ? row.tags : [],
      mistake: mistakeByEntryId.get(item.item_id) || null,
      progress: {
        status: normalizeProgressStatus(progress?.status),
        due_at: progress?.due_at || null,
        reviewed_count: Number(progress?.reviewed_count || 0),
        known_count: Number(progress?.known_count || 0),
        unknown_count: Number(progress?.unknown_count || 0),
      },
    } satisfies WebWordStudyEntry;
  });

  const { data: observations, error: observationsError } = await (
    supabase as any
  )
    .from('study_observations')
    .select('action')
    .eq('user_id', userId)
    .eq('session_id', sessionId);
  if (observationsError)
    databaseError('loadSession.observations', observationsError);
  const result = {
    known_count: 0,
    unknown_count: 0,
    skipped_count: 0,
    looked_up_count: 0,
  };
  for (const observation of observations || []) {
    if (observation.action === 'known') result.known_count += 1;
    else if (observation.action === 'unknown') result.unknown_count += 1;
    else if (observation.action === 'skipped') result.skipped_count += 1;
    else if (observation.action === 'looked_up') result.looked_up_count += 1;
  }

  return {
    ...summaryFromRow(session, deckTitles),
    items,
    result,
  };
}

export async function setWebWordStudySessionStatus(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string,
  status: WebWordSessionStatus
): Promise<WebWordStudySessionSummary> {
  const { data, error } = await supabase.rpc(
    'set_web_word_study_session_status_v1',
    {
      p_user_id: userId,
      p_session_id: sessionId,
      p_status: status,
    }
  );
  if (error) {
    const message = String(error.message || '');
    if (message.includes('WEB_WORD_SESSION_NOT_FOUND')) {
      throw new WebWordStudyError(
        'SESSION_NOT_FOUND',
        'Word study session was not found',
        404
      );
    }
    if (message.includes('WEB_WORD_SESSION_EXPIRED')) {
      throw new WebWordStudyError(
        'SESSION_EXPIRED',
        'Word study session has expired',
        409
      );
    }
    if (message.includes('WEB_WORD_SESSION_COMPLETED')) {
      throw new WebWordStudyError(
        'SESSION_COMPLETED',
        'Completed Word study sessions cannot be resumed',
        409
      );
    }
    if (message.includes('WEB_WORD_SESSION_ABANDONED')) {
      throw new WebWordStudyError(
        'SESSION_ABANDONED',
        'Ended Word study sessions cannot be resumed',
        409
      );
    }
    if (message.includes('WEB_WORD_SESSION_INCOMPLETE')) {
      throw new WebWordStudyError(
        'SESSION_INCOMPLETE',
        'Word study session still has unconfirmed items',
        409
      );
    }
    databaseError('setSessionStatus', error);
  }

  const row = data as Database['public']['Tables']['study_sessions']['Row'];
  const scope = parseScope(row.scope);
  const deckTitles = await loadDeckTitles(supabase, scope.deck_ids);
  return summaryFromRow(row, deckTitles);
}

export async function loadWordDeckStudySummaries(
  supabase: SupabaseClient<Database>,
  userId: string,
  deckIds: string[]
): Promise<Record<string, WordDeckStudySummary>> {
  const uniqueDeckIds = [...new Set(deckIds)];
  const summaries = Object.fromEntries(
    uniqueDeckIds.map(deckId => [
      deckId,
      {
        deck_id: deckId,
        total: 0,
        new_count: 0,
        learning_count: 0,
        review_count: 0,
        mastered_count: 0,
        due_count: 0,
      } satisfies WordDeckStudySummary,
    ])
  );
  if (uniqueDeckIds.length === 0) return summaries;

  const now = Date.now();
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase
      .from('word_entries')
      .select('id, deck_id, word_progress(status, due_at, user_id)')
      .in('deck_id', uniqueDeckIds)
      .eq('word_progress.user_id', userId)
      .order('deck_id', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + 499);
    if (error) databaseError('loadDeckStudySummaries', error);
    if (!data?.length) break;

    for (const row of data as any[]) {
      const summary = summaries[row.deck_id];
      if (!summary) continue;
      const progress = Array.isArray(row.word_progress)
        ? row.word_progress[0]
        : row.word_progress;
      const status = normalizeProgressStatus(progress?.status);
      summary.total += 1;
      if (status === 'learning') summary.learning_count += 1;
      else if (status === 'review') summary.review_count += 1;
      else if (status === 'mastered') summary.mastered_count += 1;
      else summary.new_count += 1;
      if (
        progress?.due_at &&
        Date.parse(progress.due_at) <= now &&
        status !== 'mastered'
      ) {
        summary.due_count += 1;
      }
    }
    if (data.length < 500) break;
  }
  return summaries;
}

export async function loadWordProgressOverview(
  supabase: SupabaseClient<Database>,
  userId: string,
  deckIds: string[]
): Promise<WebWordProgressOverview> {
  const summaries = await loadWordDeckStudySummaries(supabase, userId, deckIds);
  const decks = Object.values(summaries);
  const totals = decks.reduce(
    (result, summary) => ({
      total: result.total + summary.total,
      new_count: result.new_count + summary.new_count,
      learning_count: result.learning_count + summary.learning_count,
      review_count: result.review_count + summary.review_count,
      mastered_count: result.mastered_count + summary.mastered_count,
      due_count: result.due_count + summary.due_count,
    }),
    {
      total: 0,
      new_count: 0,
      learning_count: 0,
      review_count: 0,
      mastered_count: 0,
      due_count: 0,
    }
  );

  const { data: sessionRows, error: sessionError } = await supabase
    .from('study_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('domain', 'word')
    .order('last_activity_at', { ascending: false })
    .limit(12);
  if (sessionError) databaseError('loadProgress.sessions', sessionError);
  const allDeckIds = (sessionRows || []).flatMap(row => {
    try {
      return parseScope(row.scope).deck_ids;
    } catch {
      return [];
    }
  });
  const sessionDeckTitles = await loadDeckTitles(supabase, allDeckIds);
  const recentSessions = (sessionRows || [])
    .map(row => {
      try {
        return summaryFromRow(row, sessionDeckTitles);
      } catch {
        return null;
      }
    })
    .filter((row): row is WebWordStudySessionSummary => Boolean(row));

  let activityRows: any[] = [];
  if (sessionRows?.length) {
    const { data, error: activityError } = await (supabase as any)
      .from('study_observations')
      .select('item_id, action, occurred_at, device_id')
      .eq('user_id', userId)
      .in(
        'session_id',
        sessionRows.map(row => row.id)
      )
      .order('occurred_at', { ascending: false })
      .limit(20);
    if (activityError) databaseError('loadProgress.activity', activityError);
    activityRows = data || [];
  }
  const activityIds = (activityRows || []).map((row: any) => row.item_id);
  let entryRows: any[] = [];
  if (activityIds.length) {
    const { data, error: entryError } = await (supabase as any)
      .from('word_entries')
      .select('id, word')
      .in('id', [...new Set(activityIds)]);
    if (entryError) databaseError('loadProgress.activityEntries', entryError);
    entryRows = data || [];
  }
  const wordById = new Map(
    (entryRows || []).map((row: any) => [row.id, row.word as string])
  );
  return {
    totals,
    decks,
    recent_sessions: recentSessions,
    recent_activity: (activityRows || []).map((row: any) => ({
      item_id: row.item_id,
      word: wordById.get(row.item_id) || '词条已移除',
      action: row.action,
      occurred_at: row.occurred_at,
      device_id: row.device_id || null,
    })),
  };
}

export function normalizeWebWordStudyError(error: unknown): {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
} {
  if (
    error instanceof WebWordStudyError ||
    error instanceof WordStudyServiceError
  ) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
    };
  }
  if (error instanceof WordToolError) {
    return {
      code: error.code.toUpperCase(),
      message: error.message,
      status: error.status,
      retryable: error.status >= 500 || error.code === 'pack_revision_changed',
    };
  }
  return {
    code: 'WORD_STUDY_FAILED',
    message: 'Word study request failed',
    status: 500,
    retryable: false,
  };
}

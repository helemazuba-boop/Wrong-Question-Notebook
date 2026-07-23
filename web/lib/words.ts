import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import type { Json } from '@/lib/database.types';
import { logger } from '@/lib/logger';
import type { SupabaseClient } from '@supabase/supabase-js';

export type WordDeckSource = 'system' | 'user' | 'import' | 'ai';
export type WordLexiconType = 'english_word' | 'classical_chinese_term';
export type WordReviewStatus = 'new' | 'learning' | 'review' | 'mastered';
export type WordReviewMode = 'sequential' | 'random' | 'dictionary';
export interface WordDeckItem {
  id: string;
  title: string;
  description: string | null;
  source: WordDeckSource;
  subject_id: string | null;
  subject_name: string | null;
  language: string;
  target_language: string;
  lexicon_type: WordLexiconType;
  is_system: boolean;
  is_active: boolean;
  revision: number;
  word_count: number;
  updated_at: string;
  ai_access?: {
    can_read: boolean;
    can_create: boolean;
    can_update: boolean;
  };
}

export interface WordEntryItem {
  id: string;
  deck_id: string;
  word: string;
  normalized_word: string;
  phonetic: string | null;
  meaning: string;
  example: string | null;
  example_translation: string | null;
  part_of_speech: string | null;
  tags: string[];
  sort_index: number;
  revision: number;
  updated_at: string;
  progress?: {
    status: WordReviewStatus;
    due_at: string | null;
    interval_days: number;
    correct_streak: number;
    lapses: number;
    reviewed_count: number;
    known_count: number;
    unknown_count: number;
    last_reviewed_at: string | null;
  };
}

export interface WordDeckCreatedAction {
  type: 'word_deck_created';
  deck_id: string;
  title: string;
}

export interface WordAddedToDeckAction {
  type: 'word_added_to_deck';
  deck_id: string;
  word_id: string;
  word_entry_id: string;
  word: string;
  title: string;
}

export type WordAiAction = WordDeckCreatedAction | WordAddedToDeckAction;

export interface WordToolContext {
  userId: string;
  supabase: SupabaseClient<any>;
  conversationId?: string | null;
  deviceId?: string | null;
  source?: 'web' | 'device' | 'ai' | 'system';
}

export class WordToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'WordToolError';
  }
}

const VALID_DECK_SOURCES: WordDeckSource[] = ['system', 'user', 'import', 'ai'];
const VALID_LEXICON_TYPES: WordLexiconType[] = [
  'english_word',
  'classical_chinese_term',
];
const VALID_REVIEW_MODES: WordReviewMode[] = [
  'sequential',
  'random',
  'dictionary',
];
const VALID_REVIEW_STATUSES: WordReviewStatus[] = [
  'new',
  'learning',
  'review',
  'mastered',
];
const WORD_IMPORT_MAX_ENTRIES = 4000;
const WORD_IMPORT_UPSERT_CHUNK_SIZE = 500;

function databaseError(action: string, error: unknown): never {
  logger.error('Word database operation failed', error, {
    component: 'Words',
    action,
  });
  throw new WordToolError('database_error', 'Word request failed', 500);
}

// Returns the IDs of word decks the user can read (own + system, active, not
// archived). Use this with `.in('deck_id', deckIds)` on `word_entries`-side
// queries instead of an `word_decks!inner(...) + .or('word_decks.field.eq...')`
// nested filter — PostgREST rejects the latter with PGRST100 ("failed to parse
// logic tree", "unexpected u expecting not or operator"), because `.or()` does
// not accept dotted embedded-resource paths.
async function loadVisibleWordDeckIds(
  supabase: SupabaseClient<any>,
  userId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('word_decks')
    .select('id')
    .is('archived_at', null)
    .eq('is_active', true)
    .or(`user_id.eq.${userId},is_system.eq.true`);
  if (error) databaseError('loadVisibleWordDeckIds', error);
  return (data || []).map((row: { id: string }) => row.id);
}

function limitWithin(
  value: number | undefined,
  min: number,
  max: number
): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value || max), min), max);
}

function normalizeDeckSource(value: string): WordDeckSource {
  return VALID_DECK_SOURCES.includes(value as WordDeckSource)
    ? (value as WordDeckSource)
    : 'user';
}

function normalizeLexiconType(value: string): WordLexiconType {
  return VALID_LEXICON_TYPES.includes(value as WordLexiconType)
    ? (value as WordLexiconType)
    : 'english_word';
}

function normalizeReviewStatus(value: string): WordReviewStatus {
  return VALID_REVIEW_STATUSES.includes(value as WordReviewStatus)
    ? (value as WordReviewStatus)
    : 'new';
}

function sanitizeTitle(value: string, max = 120): string {
  const trimmed = value.trim().slice(0, max);
  if (!trimmed) {
    throw new WordToolError('invalid_request', 'Title is required', 400);
  }
  return trimmed;
}

function sanitizeOptionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

function normalizeWord(value: string): string {
  const word = value.trim().slice(0, 80);
  if (!word)
    throw new WordToolError('invalid_request', 'Word is required', 400);
  return word.toLocaleLowerCase('en-US');
}

function asJsonObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function mapDeckRow(row: any): WordDeckItem {
  const access = Array.isArray(row.word_deck_ai_access)
    ? row.word_deck_ai_access[0]
    : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    source: normalizeDeckSource(row.source),
    subject_id: row.subject_id || null,
    subject_name: row.subjects?.name || null,
    language: row.language || 'en',
    target_language: row.target_language || 'zh-CN',
    lexicon_type: normalizeLexiconType(row.lexicon_type || 'english_word'),
    is_system: Boolean(row.is_system),
    is_active: row.is_active !== false,
    revision: Number(row.revision || 1),
    word_count: normalizeCount(row.word_entries),
    updated_at: row.updated_at,
    ai_access: access
      ? {
          can_read: Boolean(access.can_read),
          can_create: Boolean(access.can_create),
          can_update: Boolean(access.can_update),
        }
      : undefined,
  };
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9' -]/g, '')
    .slice(0, 80);
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length > 0) {
    const count = (value[0] as { count?: unknown }).count;
    return typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }
  return 0;
}

function mapEntryRow(row: any): WordEntryItem {
  const progress = Array.isArray(row.word_progress)
    ? row.word_progress[0]
    : row.word_progress || null;
  return {
    id: row.id,
    deck_id: row.deck_id,
    word: row.word,
    normalized_word: row.normalized_word,
    phonetic: row.phonetic,
    meaning: row.meaning,
    example: row.example,
    example_translation: row.example_translation,
    part_of_speech: row.part_of_speech,
    tags: Array.isArray(row.tags) ? row.tags : [],
    sort_index: Number(row.sort_index || 0),
    revision: Number(row.revision || 1),
    updated_at: row.updated_at,
    progress: progress
      ? {
          status: normalizeReviewStatus(progress.status),
          due_at: progress.due_at || null,
          interval_days: Number(progress.interval_days || 0),
          correct_streak: Number(progress.correct_streak || 0),
          lapses: Number(progress.lapses || 0),
          reviewed_count: Number(progress.reviewed_count || 0),
          known_count: Number(progress.known_count || 0),
          unknown_count: Number(progress.unknown_count || 0),
          last_reviewed_at: progress.last_reviewed_at || null,
        }
      : undefined,
  };
}

function compactWordRow(entry: WordEntryItem) {
  return {
    id: entry.id,
    deck_id: entry.deck_id,
    word: entry.word,
    normalized_word: entry.normalized_word,
    phonetic: entry.phonetic,
    meaning: entry.meaning,
    example: entry.example,
    example_translation: entry.example_translation,
    part_of_speech: entry.part_of_speech,
    status: entry.progress?.status || 'new',
    due_at: entry.progress?.due_at || null,
  };
}

export async function loadWordDecks(
  supabase: SupabaseClient<any>,
  userId: string,
  options: { includeSystem?: boolean; limit?: number } = {}
): Promise<WordDeckItem[]> {
  const includeSystem = options.includeSystem !== false;
  const limit = limitWithin(options.limit, 1, 100);
  let query = supabase
    .from('word_decks')
    .select(
      'id, title, description, source, subject_id, subjects(name), language, target_language, lexicon_type, is_system, is_active, revision, updated_at, word_entries(count), word_deck_ai_access(can_read, can_create, can_update)'
    )
    .is('archived_at', null)
    .limit(limit);

  query = includeSystem
    ? query.or(`user_id.eq.${userId},is_system.eq.true`)
    : query.eq('user_id', userId);

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) throw new WordToolError('database_error', error.message, 500);
  return (data || []).map(mapDeckRow);
}

export async function createWordDeck(
  supabase: SupabaseClient<any>,
  userId: string,
  input: {
    title: string;
    description?: string | null;
    source?: WordDeckSource;
    subject_id?: string | null;
    language?: string;
    target_language?: string;
    lexicon_type?: WordLexiconType;
    metadata?: Json;
  }
): Promise<{ deck: WordDeckItem; action: WordDeckCreatedAction }> {
  const source = input.source || 'user';
  if (!['user', 'import', 'ai'].includes(source)) {
    throw new WordToolError('invalid_request', 'Invalid deck source', 400);
  }
  if (input.subject_id) {
    await verifySubjectOwner(supabase, userId, input.subject_id);
  }

  const { data, error } = await supabase
    .from('word_decks')
    .insert({
      user_id: userId,
      subject_id: input.subject_id || null,
      title: sanitizeTitle(input.title, 80),
      description: sanitizeOptionalText(input.description, 500),
      source,
      language: (input.language || 'en').trim().slice(0, 16) || 'en',
      target_language:
        (input.target_language || 'zh-CN').trim().slice(0, 16) || 'zh-CN',
      lexicon_type: normalizeLexiconType(input.lexicon_type || 'english_word'),
      is_system: false,
      is_active: true,
      metadata: asJsonObject(input.metadata),
    })
    .select(
      'id, title, description, source, subject_id, subjects(name), language, target_language, lexicon_type, is_system, is_active, revision, updated_at, word_entries(count)'
    )
    .single();

  if (error) throw new WordToolError('database_error', error.message, 500);
  const deck = mapDeckRow(data);
  return {
    deck,
    action: { type: 'word_deck_created', deck_id: deck.id, title: deck.title },
  };
}

export async function verifyWordDeckWritable(
  supabase: SupabaseClient<any>,
  userId: string,
  deckId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('word_decks')
    .select('id')
    .eq('id', deckId)
    .eq('user_id', userId)
    .eq('is_system', false)
    .is('archived_at', null)
    .maybeSingle();

  if (error) throw new WordToolError('database_error', error.message, 500);
  if (!data)
    throw new WordToolError('deck_not_found', 'Word deck not found', 404);
}

export async function verifySubjectOwner(
  supabase: SupabaseClient<any>,
  userId: string,
  subjectId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('subjects')
    .select('id')
    .eq('id', subjectId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new WordToolError('database_error', error.message, 500);
  if (!data)
    throw new WordToolError('subject_not_found', 'Subject not found', 404);
}

export async function addWordEntryToDeck(
  supabase: SupabaseClient<any>,
  userId: string,
  deckId: string,
  input: {
    word: string;
    phonetic?: string | null;
    meaning: string;
    example?: string | null;
    example_translation?: string | null;
    part_of_speech?: string | null;
    tags?: string[];
    sort_index?: number;
    metadata?: Json;
  }
): Promise<{ entry: WordEntryItem; action: WordAddedToDeckAction }> {
  await verifyWordDeckWritable(supabase, userId, deckId);

  const normalized = normalizeWord(input.word);
  const word = input.word.trim().slice(0, 80);
  const meaning = sanitizeTitle(input.meaning, 1000);
  const tags = Array.isArray(input.tags)
    ? input.tags
        .map(tag => String(tag).trim())
        .filter(Boolean)
        .slice(0, 16)
    : [];

  const { data, error } = await supabase
    .from('word_entries')
    .upsert(
      {
        deck_id: deckId,
        word,
        normalized_word: normalized,
        phonetic: sanitizeOptionalText(input.phonetic, 120),
        meaning,
        example: sanitizeOptionalText(input.example, 1000),
        example_translation: sanitizeOptionalText(
          input.example_translation,
          1000
        ),
        part_of_speech: sanitizeOptionalText(input.part_of_speech, 80),
        tags,
        sort_index: Number.isFinite(input.sort_index) ? input.sort_index : 0,
        metadata: asJsonObject(input.metadata),
        revision: 1,
      },
      { onConflict: 'deck_id,normalized_word' }
    )
    .select(
      'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at'
    )
    .single();

  if (error) throw new WordToolError('database_error', error.message, 500);
  const entry = mapEntryRow(data);
  return {
    entry,
    action: {
      type: 'word_added_to_deck',
      deck_id: deckId,
      word_id: entry.id,
      word_entry_id: entry.id,
      word: entry.word,
      title: entry.word,
    },
  };
}

export async function importWordEntriesToDeck(
  supabase: SupabaseClient<any>,
  userId: string,
  deckId: string,
  entries: Array<{
    word: string;
    phonetic?: string | null;
    meaning: string;
    example?: string | null;
    example_translation?: string | null;
    part_of_speech?: string | null;
    tags?: string[];
    sort_index?: number;
    metadata?: Json;
  }>
): Promise<{ imported_count: number; entries: WordEntryItem[] }> {
  await verifyWordDeckWritable(supabase, userId, deckId);
  if (entries.length === 0) {
    throw new WordToolError('invalid_request', 'Entries are required', 400);
  }
  if (entries.length > WORD_IMPORT_MAX_ENTRIES) {
    throw new WordToolError('invalid_request', 'Too many entries', 413);
  }

  const dedupedRows = new Map<
    string,
    {
      deck_id: string;
      word: string;
      normalized_word: string;
      phonetic: string | null;
      meaning: string;
      example: string | null;
      example_translation: string | null;
      part_of_speech: string | null;
      tags: string[];
      sort_index: number;
      metadata: Json;
      revision: number;
    }
  >();

  entries.forEach((entry, index) => {
    const word = entry.word.trim().slice(0, 80);
    const normalized = normalizeWord(word);
    const tags = Array.isArray(entry.tags)
      ? entry.tags
          .map(tag => String(tag).trim())
          .filter(Boolean)
          .slice(0, 16)
      : [];

    dedupedRows.set(normalized, {
      deck_id: deckId,
      word,
      normalized_word: normalized,
      phonetic: sanitizeOptionalText(entry.phonetic, 120),
      meaning: sanitizeTitle(entry.meaning, 1000),
      example: sanitizeOptionalText(entry.example, 1000),
      example_translation: sanitizeOptionalText(
        entry.example_translation,
        1000
      ),
      part_of_speech: sanitizeOptionalText(entry.part_of_speech, 80),
      tags,
      sort_index:
        typeof entry.sort_index === 'number' &&
        Number.isFinite(entry.sort_index)
          ? entry.sort_index
          : index,
      metadata: asJsonObject(entry.metadata),
      revision: 1,
    });
  });

  const rows = [...dedupedRows.values()];
  const imported: WordEntryItem[] = [];
  for (
    let offset = 0;
    offset < rows.length;
    offset += WORD_IMPORT_UPSERT_CHUNK_SIZE
  ) {
    const chunk = rows.slice(offset, offset + WORD_IMPORT_UPSERT_CHUNK_SIZE);
    const { data, error } = await supabase
      .from('word_entries')
      .upsert(chunk, { onConflict: 'deck_id,normalized_word' })
      .select(
        'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at'
      );

    if (error) throw new WordToolError('database_error', error.message, 500);
    imported.push(...(data || []).map(mapEntryRow));
  }
  return {
    imported_count: imported.length,
    entries: imported,
  };
}

export async function searchWords(
  supabase: SupabaseClient<any>,
  userId: string,
  input: {
    q?: string | null;
    prefix?: string | null;
    deck_id?: string | null;
    limit?: number;
  }
): Promise<{
  words: ReturnType<typeof compactWordRow>[];
  next_letters: string[];
}> {
  const limit = limitWithin(input.limit, 1, 50);
  const deckIds = await loadVisibleWordDeckIds(supabase, userId);
  if (deckIds.length === 0) {
    return { words: [], next_letters: [] };
  }

  let query = supabase
    .from('word_entries')
    .select(
      'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at, word_progress(status, due_at, interval_days, correct_streak, lapses, reviewed_count, known_count, unknown_count, last_reviewed_at)'
    )
    .in('deck_id', deckIds)
    .limit(limit);

  if (input.deck_id) query = query.eq('deck_id', input.deck_id);
  const raw = normalizeSearchText(input.prefix || input.q || '');
  if (raw)
    query = query.ilike('normalized_word', `${raw.replace(/[%_]/g, '')}%`);

  const { data, error } = await query.order('normalized_word', {
    ascending: true,
  });
  if (error) databaseError('searchWords', error);

  const words = (data || []).map(mapEntryRow).map(compactWordRow);
  const nextLetters = new Set<string>();
  words.forEach(word => {
    const nextLetter = raw
      ? word.normalized_word.charAt(raw.length)
      : word.normalized_word.charAt(0);
    if (nextLetter) nextLetters.add(nextLetter);
  });

  return {
    words,
    next_letters: [...nextLetters].sort(),
  };
}

export async function getWordDetail(
  supabase: SupabaseClient<any>,
  userId: string,
  wordId: string
): Promise<ReturnType<typeof compactWordRow>> {
  const deckIds = await loadVisibleWordDeckIds(supabase, userId);
  if (deckIds.length === 0) {
    throw new WordToolError('word_not_found', 'Word not found', 404);
  }

  const { data, error } = await supabase
    .from('word_entries')
    .select(
      'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at, word_progress(status, due_at, interval_days, correct_streak, lapses, reviewed_count, known_count, unknown_count, last_reviewed_at)'
    )
    .eq('id', wordId)
    .in('deck_id', deckIds)
    .maybeSingle();

  if (error) databaseError('getWordDetail', error);
  if (!data) throw new WordToolError('word_not_found', 'Word not found', 404);
  return compactWordRow(mapEntryRow(data));
}

export async function loadWrongWords(
  supabase: SupabaseClient<any>,
  userId: string,
  input: { limit?: number } = {}
): Promise<{ words: ReturnType<typeof compactWordRow>[] }> {
  const limit = limitWithin(input.limit, 1, 50);
  const { data, error } = await supabase
    .from('word_mistake_links')
    .select(
      'word_entries(id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at, word_progress(status, due_at, interval_days, correct_streak, lapses, reviewed_count, known_count, unknown_count, last_reviewed_at))'
    )
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) databaseError('loadWrongWords', error);
  return {
    words: (data || [])
      .map((row: any) => row.word_entries)
      .filter(Boolean)
      .map(mapEntryRow)
      .map(compactWordRow),
  };
}

export async function loadEsp32WordSync(
  supabase: SupabaseClient<any>,
  userId: string,
  input: { since?: string | null; limit?: number } = {}
) {
  const limit = limitWithin(input.limit, 1, 200);
  const since = input.since ? new Date(input.since) : null;
  const serverTime = new Date().toISOString();

  let deckQuery = supabase
    .from('word_decks')
    .select(
      'id, title, description, source, subject_id, language, target_language, lexicon_type, is_system, is_active, revision, updated_at'
    )
    .or(`user_id.eq.${userId},is_system.eq.true`)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (since && !Number.isNaN(since.getTime())) {
    deckQuery = deckQuery.gt('updated_at', since.toISOString());
  } else {
    deckQuery = deckQuery.is('archived_at', null).eq('is_active', true);
  }

  const { data: decks, error: deckError } = await deckQuery;
  if (deckError) databaseError('loadEsp32WordSync.decks', deckError);

  const { data: visibleDecks, error: visibleDeckError } = await supabase
    .from('word_decks')
    .select('id')
    .is('archived_at', null)
    .eq('is_active', true)
    .or(`user_id.eq.${userId},is_system.eq.true`);

  if (visibleDeckError)
    databaseError('loadEsp32WordSync.visibleDecks', visibleDeckError);
  const deckIds = (visibleDecks || []).map((deck: any) => deck.id);

  let entries: WordEntryItem[] = [];
  if (deckIds.length > 0) {
    let entryQuery = supabase
      .from('word_entries')
      .select(
        'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at'
      )
      .in('deck_id', deckIds)
      .order('deck_id', { ascending: true })
      .order('sort_index', { ascending: true })
      .limit(limit * 20);
    if (since && !Number.isNaN(since.getTime())) {
      entryQuery = entryQuery.gt('updated_at', since.toISOString());
    }

    const { data, error } = await entryQuery;
    if (error) databaseError('loadEsp32WordSync.entries', error);
    entries = (data || []).map(mapEntryRow);
  }

  let progressRows: any[] = [];
  let progressQuery = supabase
    .from('word_progress')
    .select(
      'word_entry_id, status, due_at, correct_streak, lapses, reviewed_count, updated_at'
    )
    .eq('user_id', userId)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (since && !Number.isNaN(since.getTime())) {
    progressQuery = progressQuery.gt('updated_at', since.toISOString());
  }

  const { data: progress, error: progressError } = await progressQuery;
  if (progressError) databaseError('loadEsp32WordSync.progress', progressError);
  progressRows = progress || [];

  const cursorValues = [
    ...(decks || []).map((deck: any) => deck.updated_at),
    ...entries.map(entry => entry.updated_at),
    ...progressRows.map(row => row.updated_at),
  ].filter(Boolean);
  const nextCursor =
    cursorValues.length > 0
      ? cursorValues.sort().at(-1)
      : input.since || serverTime;

  return {
    cursor: nextCursor,
    server_time: serverTime,
    decks: (decks || []).map((deck: any) => ({
      id: deck.id,
      title: deck.title,
      source: normalizeDeckSource(deck.source),
      subject_id: deck.subject_id || null,
      language: deck.language || 'en',
      target_language: deck.target_language || 'zh-CN',
      lexicon_type: normalizeLexiconType(deck.lexicon_type || 'english_word'),
      is_system: Boolean(deck.is_system),
      revision: Number(deck.revision || 1),
      deleted: deck.is_active === false,
    })),
    entries: entries.map(entry => ({
      id: entry.id,
      deck_id: entry.deck_id,
      word: entry.word,
      normalized_word: entry.normalized_word,
      phonetic: entry.phonetic,
      meaning: entry.meaning,
      example: entry.example,
      example_translation: entry.example_translation,
      part_of_speech: entry.part_of_speech,
      revision: entry.revision,
      deleted: false,
    })),
    progress: progressRows.map(row => ({
      word_id: row.word_entry_id,
      status: normalizeReviewStatus(row.status),
      due_at: row.due_at || null,
      correct_streak: Number(row.correct_streak || 0),
      lapses: Number(row.lapses || 0),
      revision: Math.max(1, Number(row.reviewed_count || 0) + 1),
    })),
  };
}

export async function loadEsp32WordReview(
  supabase: SupabaseClient<any>,
  userId: string,
  input: { mode?: WordReviewMode; limit?: number; deck_id?: string | null } = {}
) {
  const limit = limitWithin(input.limit, 1, 50);
  const mode = input.mode || 'sequential';
  if (!VALID_REVIEW_MODES.includes(mode)) {
    throw new WordToolError('invalid_request', 'Invalid review mode', 400);
  }

  const deckIds = await loadVisibleWordDeckIds(supabase, userId);
  if (deckIds.length === 0) {
    return {
      mode,
      daily_target: limit,
      reviewed_today: 0,
      due_count: 0,
      words: [],
    };
  }

  let query = supabase
    .from('word_entries')
    .select(
      'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at, word_progress(status, due_at, interval_days, correct_streak, lapses, reviewed_count, known_count, unknown_count, last_reviewed_at)'
    )
    .in('deck_id', deckIds)
    .order(mode === 'random' ? 'updated_at' : 'sort_index', { ascending: true })
    .limit(limit * 4);

  if (input.deck_id) query = query.eq('deck_id', input.deck_id);

  const { data, error } = await query;
  if (error) databaseError('loadEsp32WordReview.entries', error);

  const now = Date.now();
  const entries = (data || []).map(mapEntryRow);
  const dueWords = entries.filter(entry => {
    const progress = entry.progress;
    if (progress?.status === 'mastered') return false;
    if (!progress?.due_at) return true;
    return Date.parse(progress.due_at) <= now;
  });
  const words = (
    mode === 'random' ? dueWords.sort(() => Math.random() - 0.5) : dueWords
  ).slice(0, limit);

  const { count, error: countError } = await supabase
    .from('word_review_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
  if (countError)
    databaseError('loadEsp32WordReview.reviewedToday', countError);

  return {
    mode,
    daily_target: limit,
    reviewed_today: count || 0,
    due_count: dueWords.length,
    words: words.map(entry => ({
      id: entry.id,
      word: entry.word,
      phonetic: entry.phonetic,
      meaning: entry.meaning,
      example: entry.example,
      example_translation: entry.example_translation,
      status: entry.progress?.status || 'new',
    })),
  };
}

export async function getWordReviewQueue(
  supabase: SupabaseClient<any>,
  userId: string,
  input: { deck_id?: string | null; mode?: WordReviewMode; limit?: number } = {}
) {
  return loadEsp32WordReview(supabase, userId, input);
}

export async function listAuthorizedWordDecks(ctx: WordToolContext) {
  const { data, error } = await ctx.supabase
    .from('word_deck_ai_access')
    .select(
      'can_read, can_create, can_update, word_decks(id, title, description, source, subject_id, subjects(name), language, target_language, lexicon_type, word_entries(count))'
    )
    .eq('user_id', ctx.userId)
    .or('can_read.eq.true,can_create.eq.true,can_update.eq.true');
  if (error) throw new WordToolError('database_error', error.message, 500);
  return {
    decks: (data || [])
      .map((row: any) => ({
        id: row.word_decks?.id,
        title: row.word_decks?.title,
        description: row.word_decks?.description || '',
        source: row.word_decks?.source || 'user',
        subject_id: row.word_decks?.subject_id || null,
        subject_name: row.word_decks?.subjects?.name || null,
        language: row.word_decks?.language || 'en',
        target_language: row.word_decks?.target_language || 'zh-CN',
        lexicon_type: normalizeLexiconType(
          row.word_decks?.lexicon_type || 'english_word'
        ),
        word_count: normalizeCount(row.word_decks?.word_entries),
        permissions: {
          can_read: Boolean(row.can_read),
          can_create: Boolean(row.can_create),
          can_update: Boolean(row.can_update),
        },
      }))
      .filter((deck: any) => deck.id),
  };
}

export function wordSuccessResponse(data: unknown, status = 200) {
  return Response.json(createApiSuccessResponse(data), { status });
}

export function wordErrorResponse(error: unknown) {
  if (error instanceof WordToolError) {
    return Response.json(
      createApiErrorResponse(error.message, error.status, { code: error.code }),
      { status: error.status }
    );
  }
  return Response.json(
    createApiErrorResponse('Word request failed', 500, { code: 'word_failed' }),
    { status: 500 }
  );
}

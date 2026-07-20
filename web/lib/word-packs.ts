import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { WordToolError } from '@/lib/words';
import {
  WORD_PACK_MAX_BYTES,
  WORD_PACK_MAX_ENTRIES,
  WORD_PACK_SCHEMA_VERSION,
} from '@/lib/word-study-v1';

export const WORD_PACK_BUCKET = 'word-packs';
export const WORD_PACK_MAGIC = 'WQN_WORD_PACK_V2';
export const WORD_PACK_FORMAT = 'jsonl';
export const WORD_PACK_COMPRESSION = 'none';
export const WORD_PACK_MAX_LINE_BYTES = 8191;

export interface WordPackManifestItem {
  pack_id: string;
  deck_id: string;
  title: string;
  subject_id: string | null;
  revision: number;
  content_revision: number;
  pack_revision: number;
  change_sequence: number;
  schema_version: number;
  format: string;
  compression: string;
  lexicon_type: string;
  entry_count: number;
  byte_size: number;
  sha256: string;
  download_url: string;
}

export interface VisibleDeckRow {
  id: string;
  title: string;
  description: string | null;
  source: string;
  language: string;
  target_language: string;
  subject_id: string | null;
  lexicon_type: string;
  is_system: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface WordEntryPackRow {
  id: string;
  deck_id: string;
  word: string;
  normalized_word: string;
  phonetic: string | null;
  meaning: string;
  example: string | null;
  example_translation: string | null;
  part_of_speech: string | null;
  tags: string[] | null;
  sort_index: number;
  revision: number;
  updated_at: string;
}

interface WordPackRow {
  id: string;
  deck_id: string;
  revision: number;
  schema_version: number;
  format: string;
  compression: string;
  storage_path: string;
  sha256: string;
  byte_size: number;
  entry_count: number;
  status: string;
}

function databaseError(action: string, error: unknown): never {
  logger.error('Word pack database operation failed', error, {
    component: 'WordPacks',
    action,
  });
  throw new WordToolError('database_error', 'Word pack request failed', 500);
}

function storageError(action: string, error: unknown): never {
  logger.error('Word pack storage operation failed', error, {
    component: 'WordPacks',
    action,
  });
  throw new WordToolError('storage_error', 'Word pack storage failed', 500);
}

function compactEntry(entry: WordEntryPackRow) {
  return {
    id: entry.id,
    word: entry.word,
    normalized_word: entry.normalized_word,
    phonetic: entry.phonetic,
    meaning: entry.meaning,
    example: entry.example,
    example_translation: entry.example_translation,
    part_of_speech: entry.part_of_speech,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    sort_index: Number(entry.sort_index || 0),
    revision: Number(entry.revision || 1),
  };
}

export function buildDeterministicWordPackBytes(
  deck: VisibleDeckRow,
  entries: WordEntryPackRow[]
): Buffer {
  if (entries.length > WORD_PACK_MAX_ENTRIES) {
    throw new WordToolError(
      'pack_too_many_entries',
      `Word pack exceeds ${WORD_PACK_MAX_ENTRIES} entries`,
      409
    );
  }
  const metadata = {
    deck_id: deck.id,
    title: deck.title,
    source: deck.is_system ? 'system' : 'user',
    revision: Number(deck.revision || 1),
    schema_version: WORD_PACK_SCHEMA_VERSION,
    format: WORD_PACK_FORMAT,
    compression: WORD_PACK_COMPRESSION,
    language: deck.language || 'en',
    target_language: deck.target_language || 'zh-CN',
    subject_id: deck.subject_id || null,
    lexicon_type: deck.lexicon_type || 'english_word',
    entry_count: entries.length,
  };

  const lines = [
    WORD_PACK_MAGIC,
    JSON.stringify(metadata),
    ...entries.map(entry => JSON.stringify(compactEntry(entry))),
  ];

  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > WORD_PACK_MAX_LINE_BYTES) {
      throw new WordToolError(
        'pack_line_too_large',
        `Word pack line exceeds ${WORD_PACK_MAX_LINE_BYTES} bytes`,
        409
      );
    }
  }

  const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  if (bytes.byteLength > WORD_PACK_MAX_BYTES) {
    throw new WordToolError(
      'pack_too_large',
      `Word pack exceeds ${WORD_PACK_MAX_BYTES} bytes`,
      409
    );
  }
  return bytes;
}

function buildStoragePath(deck: VisibleDeckRow, sha256: string): string {
  const owner = deck.is_system ? 'system' : `user/${deck.id}`;
  return `${owner}/decks/${deck.id}/rev-${deck.revision}-${sha256.slice(0, 16)}.jsonl`;
}

export async function loadVisibleWordPackDecks(
  supabase: SupabaseClient<any>,
  userId: string
): Promise<VisibleDeckRow[]> {
  const { data, error } = await supabase
    .from('word_decks')
    .select(
      'id, title, description, source, subject_id, language, target_language, lexicon_type, is_system, revision, created_at, updated_at'
    )
    .is('archived_at', null)
    .eq('is_active', true)
    .eq('lexicon_type', 'english_word')
    .or(`user_id.eq.${userId},is_system.eq.true`)
    .order('is_system', { ascending: false })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(100);

  if (error) databaseError('loadVisibleDecks', error);
  return data || [];
}

export async function loadVisibleWordPackDecksByIds(
  supabase: SupabaseClient<any>,
  userId: string,
  deckIds: string[]
): Promise<VisibleDeckRow[]> {
  if (deckIds.length === 0) return [];
  const { data, error } = await supabase
    .from('word_decks')
    .select(
      'id, title, description, source, subject_id, language, target_language, lexicon_type, is_system, revision, created_at, updated_at'
    )
    .in('id', deckIds)
    .is('archived_at', null)
    .eq('is_active', true)
    .eq('lexicon_type', 'english_word')
    .or(`user_id.eq.${userId},is_system.eq.true`)
    .order('is_system', { ascending: false })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(100);

  if (error) databaseError('loadVisibleDecksByIds', error);
  return data || [];
}

async function loadDeckEntries(
  supabase: SupabaseClient<any>,
  deckId: string
): Promise<WordEntryPackRow[]> {
  const { data, error } = await supabase
    .from('word_entries')
    .select(
      'id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at'
    )
    .eq('deck_id', deckId)
    .order('sort_index', { ascending: true })
    .order('normalized_word', { ascending: true });

  if (error) databaseError('loadDeckEntries', error);
  return data || [];
}

async function loadReadyPack(
  supabase: SupabaseClient<any>,
  deckId: string,
  revision: number
): Promise<WordPackRow | null> {
  const { data, error } = await supabase
    .from('word_packs')
    .select(
      'id, deck_id, revision, schema_version, format, compression, storage_path, sha256, byte_size, entry_count, status'
    )
    .eq('deck_id', deckId)
    .eq('revision', revision)
    .eq('schema_version', WORD_PACK_SCHEMA_VERSION)
    .eq('format', WORD_PACK_FORMAT)
    .eq('compression', WORD_PACK_COMPRESSION)
    .eq('status', 'ready')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) databaseError('loadReadyPack', error);
  return data;
}

async function upsertPackRecord(
  supabase: SupabaseClient<any>,
  deck: VisibleDeckRow,
  storagePath: string,
  bytes: Buffer,
  entryCount: number
): Promise<WordPackRow> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const byteSize = bytes.byteLength;

  const { error: uploadError } = await supabase.storage
    .from(WORD_PACK_BUCKET)
    .upload(storagePath, bytes, {
      contentType: 'application/x-ndjson',
      upsert: false,
    });

  if (
    uploadError &&
    !String(uploadError.message || '')
      .toLowerCase()
      .includes('already exists')
  ) {
    storageError('uploadPack', uploadError);
  }

  const { data, error } = await supabase
    .from('word_packs')
    .upsert(
      {
        deck_id: deck.id,
        revision: Number(deck.revision || 1),
        schema_version: WORD_PACK_SCHEMA_VERSION,
        format: WORD_PACK_FORMAT,
        compression: WORD_PACK_COMPRESSION,
        storage_path: storagePath,
        sha256,
        byte_size: byteSize,
        entry_count: entryCount,
        status: 'ready',
      },
      { onConflict: 'deck_id,revision,schema_version,format,compression' }
    )
    .select(
      'id, deck_id, revision, schema_version, format, compression, storage_path, sha256, byte_size, entry_count, status'
    )
    .single();

  if (error) databaseError('upsertPackRecord', error);
  return data;
}

async function pruneOldReadyPacks(
  supabase: SupabaseClient<any>,
  deckId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('word_packs')
    .select('id, storage_path')
    .eq('deck_id', deckId)
    .eq('schema_version', WORD_PACK_SCHEMA_VERSION)
    .eq('status', 'ready')
    .order('revision', { ascending: false })
    .order('updated_at', { ascending: false })
    .range(2, 101);
  if (error) databaseError('pruneOldReadyPacks.lookup', error);
  if (!data?.length) return;

  const { error: staleError } = await supabase
    .from('word_packs')
    .update({ status: 'stale' })
    .in(
      'id',
      data.map(pack => pack.id)
    );
  if (staleError) databaseError('pruneOldReadyPacks.markStale', staleError);

  const { error: removeError } = await supabase.storage
    .from(WORD_PACK_BUCKET)
    .remove(data.map(pack => pack.storage_path));
  if (removeError) {
    // Stale rows can no longer be downloaded. Object deletion is best effort
    // and can be retried without weakening the two-revision visibility bound.
    logger.warn('Failed to remove stale word pack objects', {
      component: 'WordPacks',
      action: 'pruneOldReadyPacks.remove',
      deckId,
      count: data.length,
    });
  }
}

export async function ensureWordPackForDeck(
  supabase: SupabaseClient<any>,
  deck: VisibleDeckRow
): Promise<WordPackRow> {
  const revision = Number(deck.revision || 1);
  const existing = await loadReadyPack(supabase, deck.id, revision);
  // The content-addressed path and immutable download response make the
  // database row sufficient here. Downloading a multi-megabyte object merely
  // to prove existence made every manifest request scale with pack size.
  if (existing) return existing;

  const entries = await loadDeckEntries(supabase, deck.id);
  const { data: currentDeck, error: revisionError } = await supabase
    .from('word_decks')
    .select('revision')
    .eq('id', deck.id)
    .single();
  if (revisionError)
    databaseError('ensureWordPackForDeck.revision', revisionError);
  if (Number(currentDeck.revision) !== revision) {
    throw new WordToolError(
      'pack_revision_changed',
      'Word deck changed while its pack was being generated',
      409
    );
  }
  const bytes = buildDeterministicWordPackBytes(deck, entries);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pack = await upsertPackRecord(
    supabase,
    deck,
    buildStoragePath(deck, sha256),
    bytes,
    entries.length
  );
  await pruneOldReadyPacks(supabase, deck.id);
  return pack;
}

export async function loadWordPackManifest(
  supabase: SupabaseClient<any>,
  userId: string,
  origin: string
): Promise<{ packs: WordPackManifestItem[] }> {
  const decks = await loadVisibleWordPackDecks(supabase, userId);
  const packs: WordPackManifestItem[] = [];
  // Serial generation bounds peak memory to one pack. A manifest request may
  // cover many decks, but never materializes all pack buffers concurrently.
  for (const deck of decks) {
    const pack = await ensureWordPackForDeck(supabase, deck);
    const { data: change, error: changeError } = await supabase
      .from('word_change_log')
      .select('sequence')
      .eq('deck_id', deck.id)
      .or(`user_id.is.null,user_id.eq.${userId}`)
      .order('sequence', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (changeError) databaseError('loadWordPackManifest.change', changeError);
    packs.push({
      pack_id: pack.id,
      deck_id: deck.id,
      title: deck.title,
      subject_id: deck.subject_id || null,
      revision: Number(pack.revision),
      content_revision: Number(deck.revision),
      pack_revision: Number(pack.revision),
      change_sequence: Number(change?.sequence || 0),
      schema_version: Number(pack.schema_version),
      format: pack.format,
      compression: pack.compression,
      lexicon_type: deck.lexicon_type || 'english_word',
      entry_count: Number(pack.entry_count),
      byte_size: Number(pack.byte_size),
      sha256: pack.sha256,
      download_url: `${origin}/api/esp32/words/packs/${pack.id}`,
    });
  }

  return { packs };
}

export interface WordStudyManifestDeck {
  deck_id: string;
  title: string;
  change_sequence: number;
  content_revision: number;
  deleted: boolean;
  pack: {
    pack_id: string;
    pack_revision: number;
    schema_version: 2;
    format: 'jsonl';
    compression: 'none';
    entry_count: number;
    byte_size: number;
    sha256: string;
    download_url: string;
  } | null;
}

export async function loadWordStudyManifest(
  supabase: SupabaseClient<any>,
  userId: string,
  origin: string,
  afterSequence: number,
  limit = 100
): Promise<{
  cursor: string;
  has_more: boolean;
  decks: WordStudyManifestDeck[];
}> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const { data: changes, error } = await supabase
    .from('word_change_log')
    .select('sequence, deck_id, entity_kind, operation, payload')
    .gt('sequence', afterSequence)
    .in('entity_kind', ['deck', 'entry', 'pack'])
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .order('sequence', { ascending: true })
    .limit(boundedLimit + 1);
  if (error) databaseError('loadWordStudyManifest.changes', error);

  const page = (changes || []).slice(0, boundedLimit);
  const cursor = page.length
    ? Number(page[page.length - 1].sequence)
    : afterSequence;
  const latestByDeck = new Map<string, (typeof page)[number]>();
  for (const change of page) latestByDeck.set(change.deck_id, change);

  const visibleDecks = await loadVisibleWordPackDecksByIds(supabase, userId, [
    ...latestByDeck.keys(),
  ]);
  const visibleById = new Map(visibleDecks.map(deck => [deck.id, deck]));
  const decks: WordStudyManifestDeck[] = [];
  for (const change of latestByDeck.values()) {
    const deck = visibleById.get(change.deck_id);
    if (
      !deck ||
      (change.entity_kind === 'deck' && change.operation === 'delete')
    ) {
      const payload =
        change.payload && typeof change.payload === 'object'
          ? (change.payload as Record<string, unknown>)
          : {};
      decks.push({
        deck_id: change.deck_id,
        title: String(payload.title || '已删除词库').slice(0, 80),
        change_sequence: Number(change.sequence),
        content_revision: Number(payload.content_revision || 1),
        deleted: true,
        pack: null,
      });
      continue;
    }

    const pack = await ensureWordPackForDeck(supabase, deck);
    decks.push({
      deck_id: deck.id,
      title: deck.title,
      change_sequence: Number(change.sequence),
      content_revision: Number(deck.revision),
      deleted: false,
      pack: {
        pack_id: pack.id,
        pack_revision: Number(pack.revision),
        schema_version: 2,
        format: 'jsonl',
        compression: 'none',
        entry_count: Number(pack.entry_count),
        byte_size: Number(pack.byte_size),
        sha256: pack.sha256,
        download_url: `${origin}/api/esp32/v3/words/packs/${pack.id}`,
      },
    });
  }

  return {
    cursor: String(cursor),
    has_more: (changes || []).length > boundedLimit,
    decks,
  };
}

export async function getDownloadableWordPack(
  supabase: SupabaseClient<any>,
  userId: string,
  packId: string
): Promise<{
  pack: WordPackRow;
  deck: Pick<VisibleDeckRow, 'id' | 'title' | 'is_system'>;
  body: ArrayBuffer;
}> {
  // Two flat queries instead of a single nested one. The previous query used
  // a `word_decks!inner(...)` embed with `.or('word_decks.user_id.eq.X,
  // word_decks.is_system.eq.true')`, which PostgREST rejected:
  //   PGRST100: failed to parse logic tree (... word_decks.user_id.eq.X ...)
  //   unexpected "u" expecting "not" or operator
  // The `.or()` parser doesn't accept dotted embedded-resource paths the same
  // way `.eq()` does. Splitting into pack-then-deck and enforcing ownership in
  // JS (the same shape loadVisibleDecks already uses) sidesteps the parser
  // limitation entirely.
  const { data: pack, error: packError } = await supabase
    .from('word_packs')
    .select(
      'id, deck_id, revision, schema_version, format, compression, storage_path, sha256, byte_size, entry_count, status'
    )
    .eq('id', packId)
    .eq('status', 'ready')
    .maybeSingle();
  if (packError) databaseError('getDownloadableWordPack.lookup', packError);
  if (!pack) {
    throw new WordToolError('pack_not_found', 'Word pack not found', 404);
  }

  const { data: deck, error: deckError } = await supabase
    .from('word_decks')
    .select('id, title, is_system, user_id, is_active, archived_at')
    .eq('id', pack.deck_id)
    .maybeSingle();
  if (deckError) databaseError('getDownloadableWordPack.deck', deckError);

  if (
    !deck ||
    !deck.is_active ||
    deck.archived_at ||
    !(deck.is_system || deck.user_id === userId)
  ) {
    throw new WordToolError('pack_not_found', 'Word pack not found', 404);
  }

  const { data: blob, error: downloadError } = await supabase.storage
    .from(WORD_PACK_BUCKET)
    .download(pack.storage_path);

  if (downloadError || !blob) storageError('downloadPack', downloadError);

  return {
    pack,
    deck,
    body: await blob.arrayBuffer(),
  };
}

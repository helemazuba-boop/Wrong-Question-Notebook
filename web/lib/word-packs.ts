import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { WordToolError } from '@/lib/words';

export const WORD_PACK_BUCKET = 'word-packs';
export const WORD_PACK_MAGIC = 'WQN_WORD_PACK_V1';
export const WORD_PACK_SCHEMA_VERSION = 1;
export const WORD_PACK_FORMAT = 'jsonl';
export const WORD_PACK_COMPRESSION = 'none';

export interface WordPackManifestItem {
  pack_id: string;
  deck_id: string;
  title: string;
  subject_id: string | null;
  revision: number;
  schema_version: number;
  format: string;
  compression: string;
  lexicon_type: string;
  entry_count: number;
  byte_size: number;
  sha256: string;
  download_url: string;
}

interface VisibleDeckRow {
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
    updated_at: entry.updated_at,
  };
}

function buildPackBytes(deck: VisibleDeckRow, entries: WordEntryPackRow[]): Buffer {
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
    generated_at: new Date().toISOString(),
  };

  const lines = [
    WORD_PACK_MAGIC,
    JSON.stringify(metadata),
    ...entries.map(entry => JSON.stringify(compactEntry(entry))),
  ];

  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function buildStoragePath(deck: VisibleDeckRow): string {
  const owner = deck.is_system ? 'system' : `user/${deck.id}`;
  return `${owner}/decks/${deck.id}/rev-${deck.revision}.jsonl`;
}

async function loadVisibleDecks(
  supabase: SupabaseClient<any>,
  userId: string
): Promise<VisibleDeckRow[]> {
  const { data, error } = await supabase
    .from('word_decks')
    .select('id, title, description, source, subject_id, language, target_language, lexicon_type, is_system, revision, updated_at')
    .is('archived_at', null)
    .eq('is_active', true)
    .or(`user_id.eq.${userId},is_system.eq.true`)
    .order('is_system', { ascending: false })
    .order('updated_at', { ascending: false });

  if (error) databaseError('loadVisibleDecks', error);
  return data || [];
}

async function loadDeckEntries(
  supabase: SupabaseClient<any>,
  deckId: string
): Promise<WordEntryPackRow[]> {
  const { data, error } = await supabase
    .from('word_entries')
    .select('id, deck_id, word, normalized_word, phonetic, meaning, example, example_translation, part_of_speech, tags, sort_index, revision, updated_at')
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
    .select('id, deck_id, revision, schema_version, format, compression, storage_path, sha256, byte_size, entry_count, status')
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

async function verifyPackObject(
  supabase: SupabaseClient<any>,
  storagePath: string
): Promise<boolean> {
  const { data, error } = await supabase.storage
    .from(WORD_PACK_BUCKET)
    .download(storagePath);

  if (error || !data) return false;
  return true;
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
      upsert: true,
    });

  if (uploadError) storageError('uploadPack', uploadError);

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
    .select('id, deck_id, revision, schema_version, format, compression, storage_path, sha256, byte_size, entry_count, status')
    .single();

  if (error) databaseError('upsertPackRecord', error);
  return data;
}

export async function ensureWordPackForDeck(
  supabase: SupabaseClient<any>,
  deck: VisibleDeckRow
): Promise<WordPackRow> {
  const revision = Number(deck.revision || 1);
  const existing = await loadReadyPack(supabase, deck.id, revision);
  if (existing && (await verifyPackObject(supabase, existing.storage_path))) {
    return existing;
  }

  const entries = await loadDeckEntries(supabase, deck.id);
  const bytes = buildPackBytes(deck, entries);
  return upsertPackRecord(
    supabase,
    deck,
    buildStoragePath(deck),
    bytes,
    entries.length
  );
}

export async function loadWordPackManifest(
  supabase: SupabaseClient<any>,
  userId: string,
  origin: string
): Promise<{ packs: WordPackManifestItem[] }> {
  const decks = await loadVisibleDecks(supabase, userId);
  const packs = await Promise.all(
    decks.map(async deck => {
      const pack = await ensureWordPackForDeck(supabase, deck);
      return {
        pack_id: pack.id,
        deck_id: deck.id,
        title: deck.title,
        subject_id: deck.subject_id || null,
        revision: Number(pack.revision),
        schema_version: Number(pack.schema_version),
        format: pack.format,
        compression: pack.compression,
        lexicon_type: deck.lexicon_type || 'english_word',
        entry_count: Number(pack.entry_count),
        byte_size: Number(pack.byte_size),
        sha256: pack.sha256,
        download_url: `${origin}/api/esp32/words/packs/${pack.id}`,
      };
    })
  );

  return { packs };
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
  const { data, error } = await supabase
    .from('word_packs')
    .select('id, deck_id, revision, schema_version, format, compression, storage_path, sha256, byte_size, entry_count, status, word_decks!inner(id, title, is_system, user_id, is_active, archived_at)')
    .eq('id', packId)
    .eq('status', 'ready')
    .or(`word_decks.user_id.eq.${userId},word_decks.is_system.eq.true`)
    .maybeSingle();

  if (error) databaseError('getDownloadableWordPack.lookup', error);
  const deck = Array.isArray(data?.word_decks)
    ? data?.word_decks[0]
    : data?.word_decks;

  if (!data || !deck?.is_active || deck?.archived_at) {
    throw new WordToolError('pack_not_found', 'Word pack not found', 404);
  }

  const { data: blob, error: downloadError } = await supabase.storage
    .from(WORD_PACK_BUCKET)
    .download(data.storage_path);

  if (downloadError || !blob) storageError('downloadPack', downloadError);

  return {
    pack: data,
    deck,
    body: await blob.arrayBuffer(),
  };
}

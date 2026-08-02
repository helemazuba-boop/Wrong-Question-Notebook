import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { listWordEntriesForDeck } from '@/lib/words';
import WordDeckPageClient, {
  type WordDeckView,
  type WordEntryView,
} from './word-deck-page-client';

type WordSupabase = {
  from: (table: string) => any;
};

type DeckRow = {
  id: string;
  title: string;
  description: string | null;
  source: string;
  subject_id?: string | null;
  subjects?: { name?: string | null } | { name?: string | null }[] | null;
  language: string | null;
  target_language: string | null;
  lexicon_type?: string | null;
  is_system: boolean | null;
  is_active: boolean | null;
  revision: number | string | null;
  updated_at: string | null;
  word_entries?: number | { count?: number | null }[] | null;
  word_deck_ai_access?:
    | {
        can_read?: boolean | null;
        can_create?: boolean | null;
        can_update?: boolean | null;
      }[]
    | null;
};

export async function generateMetadata(): Promise<Metadata> {
  return { title: '词库管理' };
}

function normalizeCount(value: DeckRow['word_entries']): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length > 0) {
    const count = value[0]?.count;
    return typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }
  return 0;
}

function normalizeSubjectName(row: DeckRow): string | null {
  const subject = Array.isArray(row.subjects) ? row.subjects[0] : row.subjects;
  return subject?.name || null;
}

function mapDeck(row: DeckRow): WordDeckView {
  const access = Array.isArray(row.word_deck_ai_access)
    ? row.word_deck_ai_access[0]
    : null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    source: row.source || 'user',
    subject_id: row.subject_id ?? null,
    subject_name: normalizeSubjectName(row),
    language: row.language || 'en',
    target_language: row.target_language || 'zh-CN',
    lexicon_type: row.lexicon_type ?? null,
    is_system: Boolean(row.is_system),
    is_active: row.is_active !== false,
    revision: Number(row.revision || 1),
    word_count: normalizeCount(row.word_entries),
    updated_at: row.updated_at || new Date(0).toISOString(),
    ai_access: access
      ? {
          can_read: Boolean(access.can_read),
          can_create: Boolean(access.can_create),
          can_update: Boolean(access.can_update),
        }
      : undefined,
  };
}

async function queryDeck(
  supabase: WordSupabase,
  userId: string,
  deckId: string,
  includeOptionalFields: boolean
) {
  const baseFields =
    'id, title, description, source, language, target_language, is_system, is_active, revision, updated_at, word_entries(count), word_deck_ai_access(can_read, can_create, can_update)';
  const optionalFields = includeOptionalFields
    ? 'subject_id, lexicon_type, subjects(name), '
    : '';

  return supabase
    .from('word_decks')
    .select(`${optionalFields}${baseFields}`)
    .eq('id', deckId)
    .eq('is_active', true)
    .is('archived_at', null)
    .or(`user_id.eq.${userId},is_system.eq.true`)
    .maybeSingle();
}

async function loadDeck(
  supabase: WordSupabase,
  userId: string,
  deckId: string
): Promise<WordDeckView | null> {
  let result = await queryDeck(supabase, userId, deckId, true);

  if (result.error) {
    result = await queryDeck(supabase, userId, deckId, false);
  }

  if (result.error || !result.data) return null;
  return mapDeck(result.data as DeckRow);
}

async function loadPageData(deckId: string) {
  const { user, supabase } = await requireUser();
  if (!user) return { user: null, deck: null, entries: [], entryCount: null };

  const wordsSupabase = supabase as unknown as WordSupabase;
  const deck = await loadDeck(wordsSupabase, user.id, deckId);
  if (!deck) return { user, deck: null, entries: [], entryCount: null };

  const { entries, count } = await listWordEntriesForDeck(
    supabase,
    user.id,
    deckId,
    { limit: 50, offset: 0 }
  );
  return {
    user,
    deck,
    entries: entries as WordEntryView[],
    entryCount: count ?? deck.word_count,
  };
}

export default async function WordDeckPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await loadPageData(id);

  if (!data.user) {
    redirect(`/auth/login?redirect=/words/decks/${id}`);
  }

  if (!data.deck) {
    notFound();
  }

  return (
    <WordDeckPageClient
      deck={data.deck}
      initialEntries={data.entries}
      initialEntryCount={data.entryCount}
    />
  );
}

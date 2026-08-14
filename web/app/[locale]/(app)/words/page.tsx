import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { loadWordDecks } from '@/lib/words';
import {
  loadResumableWebWordStudySessions,
  loadWordDeckStudySummaries,
} from '@/lib/word-study-web';
import WordsPageClient from './words-page-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Word 学习' };
}

export default async function WordsPage() {
  const { user, supabase } = await requireUser();
  if (!user) redirect('/auth/login?redirect=/words');

  const decks = await loadWordDecks(supabase, user.id, {
    includeSystem: true,
    limit: 100,
  });
  const service = createServiceClient();
  const [summaries, sessions] = await Promise.all([
    loadWordDeckStudySummaries(
      service,
      user.id,
      decks.map(deck => deck.id)
    ),
    loadResumableWebWordStudySessions(service, user.id),
  ]);

  return (
    <WordsPageClient
      initialDecks={decks}
      initialSummaries={summaries}
      initialSessions={sessions}
    />
  );
}

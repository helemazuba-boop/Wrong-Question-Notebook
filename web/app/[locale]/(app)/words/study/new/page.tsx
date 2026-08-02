import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { loadWordDecks } from '@/lib/words';
import NewWordStudySessionClient from './new-word-study-session-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: '开始 Word 学习' };
}

export default async function NewWordStudySessionPage() {
  const { user, supabase } = await requireUser();
  if (!user) redirect('/auth/login?redirect=/words/study/new');
  const decks = await loadWordDecks(supabase, user.id, {
    includeSystem: true,
    limit: 100,
  });
  return <NewWordStudySessionClient decks={decks} />;
}

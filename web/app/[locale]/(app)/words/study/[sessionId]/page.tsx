import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  loadWebWordStudySession,
  WebWordStudyError,
} from '@/lib/word-study-web';
import WordStudySessionClient from './word-study-session-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Word 学习会话' };
}

export default async function WordStudySessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const { user } = await requireUser();
  if (!user) {
    redirect(`/auth/login?redirect=/words/study/${sessionId}`);
  }

  try {
    const session = await loadWebWordStudySession(
      createServiceClient(),
      user.id,
      sessionId
    );
    return <WordStudySessionClient initialSession={session} />;
  } catch (error) {
    if (
      error instanceof WebWordStudyError &&
      error.code === 'SESSION_NOT_FOUND'
    ) {
      notFound();
    }
    throw error;
  }
}

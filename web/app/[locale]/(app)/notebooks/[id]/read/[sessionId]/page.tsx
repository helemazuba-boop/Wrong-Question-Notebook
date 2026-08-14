import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  loadWebNoteStudySession,
  WebNoteStudyError,
} from '@/lib/note-study-web';
import NoteReadingSessionClient from './note-reading-session-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Note 阅读' };
}

export default async function NoteReadingSessionPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;
  const { user } = await requireUser();
  if (!user) {
    redirect(`/auth/login?redirect=/notebooks/${id}/read/${sessionId}`);
  }
  try {
    const session = await loadWebNoteStudySession(
      createServiceClient(),
      user.id,
      sessionId
    );
    if (!session.notebook_ids.includes(id)) notFound();
    return (
      <NoteReadingSessionClient notebookId={id} initialSession={session} />
    );
  } catch (error) {
    if (
      error instanceof WebNoteStudyError &&
      error.code === 'SESSION_NOT_FOUND'
    ) {
      notFound();
    }
    throw error;
  }
}

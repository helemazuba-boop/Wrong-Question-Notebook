import { getTranslations as getFeatureTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { listNotes } from '@/lib/notebook-content-service';
import {
  loadNotebookReadSummaries,
  loadRecentNoteReads,
  loadResumableWebNoteStudySessions,
} from '@/lib/note-study-web';
import NotebookPageClient from './notebook-page-client';

type NotebookRow = {
  id: string;
  title: string;
  description: string | null;
  subject_id: string;
  updated_at: string;
  revision: number;
  subjects: { name: string } | null;
  notebook_ai_access: {
    can_read: boolean;
    can_create: boolean;
    can_update: boolean;
  }[];
};

async function loadNotebook(id: string) {
  const { user, supabase } = await requireUser();
  if (!user) return null;

  const { data: notebook, error: notebookError } = await supabase
    .from('notebooks')
    .select(
      'id, title, description, subject_id, updated_at, revision, subjects(name), notebook_ai_access(can_read, can_create, can_update)'
    )
    .eq('id', id)
    .eq('user_id', user.id)
    .is('archived_at', null)
    .maybeSingle();

  if (notebookError || !notebook) return null;

  const [notesResult, summaries, recentReads, resumableSessions] =
    await Promise.all([
      listNotes(supabase, user.id, id, { order: 'stable', limit: 50 }),
      loadNotebookReadSummaries(supabase, user.id, [id]),
      loadRecentNoteReads(supabase, user.id, {
        notebook_id: id,
        limit: 8,
      }),
      loadResumableWebNoteStudySessions(supabase, user.id, {
        notebook_id: id,
        limit: 1,
      }),
    ]);

  return {
    notebook: notebook as NotebookRow,
    notes: notesResult.notes,
    readSummary: summaries[id],
    recentReads,
    resumableSession: resumableSessions[0] || null,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const tFeature = await getFeatureTranslations('Notes');

  const { id } = await params;
  const { user, supabase } = await requireUser();
  if (!user) return { title: tFeature('notebook') };
  // Metadata needs only a title. Notes, read history and resumable sessions
  // belong to the page load and must not be prepared a second time here.
  const { data, error } = await supabase
    .from('notebooks')
    .select('title')
    .eq('id', id)
    .eq('user_id', user.id)
    .is('archived_at', null)
    .maybeSingle();
  return { title: (!error && data?.title) || tFeature('notebook') };
}

export default async function NotebookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await loadNotebook(id);
  if (!data) notFound();

  const access = Array.isArray(data.notebook.notebook_ai_access)
    ? data.notebook.notebook_ai_access[0]
    : null;

  return (
    <NotebookPageClient
      notebook={{
        id: data.notebook.id,
        title: data.notebook.title,
        description: data.notebook.description,
        subject_id: data.notebook.subject_id,
        subject_name: data.notebook.subjects?.name || '',
        updated_at: data.notebook.updated_at,
        revision: Number(data.notebook.revision ?? 1),
        ai_access: {
          can_read: Boolean(access?.can_read),
          can_create: Boolean(access?.can_create),
          can_update: Boolean(access?.can_update),
        },
      }}
      initialNotes={data.notes}
      initialReadSummary={data.readSummary}
      initialRecentReads={data.recentReads}
      initialResumableSession={data.resumableSession}
    />
  );
}

import type { Metadata } from 'next';
import type { SupabaseClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/requireUser';
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

type NoteRow = {
  id: string;
  notebook_id: string;
  title: string;
  content: string;
  content_format: string;
  source: string;
  linked_problem_id: string | null;
  revision: number;
  sort_index: number;
  created_at: string;
  updated_at: string;
};

async function loadNotebook(id: string) {
  const supabase = await createClient();
  const { user } = await requireUser();
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

  // sort_index / content_format are added by 20260724000000 and are not yet in
  // the generated database types; cast to an untyped client for this read.
  const { data: notes, error: notesError } = await (
    supabase as unknown as SupabaseClient<any>
  )
    .from('notebook_notes')
    .select(
      'id, notebook_id, title, content, content_format, source, linked_problem_id, revision, sort_index, created_at, updated_at'
    )
    .eq('notebook_id', id)
    .eq('user_id', user.id)
    .is('archived_at', null)
    .order('sort_index', { ascending: true })
    .order('id', { ascending: true })
    .limit(50);

  if (notesError) {
    console.error('Failed to load notebook notes:', notesError);
  }

  return {
    notebook: notebook as NotebookRow,
    notes: (notes || []) as NoteRow[],
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const data = await loadNotebook(id);
  return { title: data?.notebook.title || '笔记本' };
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
    />
  );
}

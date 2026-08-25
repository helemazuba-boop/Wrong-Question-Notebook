import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import SubjectsPageClient from './subjects-page-client';
import { createClient } from '@/lib/supabase/server';
import { getAuthenticatedPrincipal } from '@/lib/supabase/auth-principal';
import { SubjectWithMetadata } from '@/lib/types';
import { loadNotebookShelf, type NotebookShelfItem } from '@/lib/notebooks';
import {
  ensurePresetSubjects,
  prepareSubjectsForNotebookShelf,
} from '@/lib/subject-presets';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata');
  return { title: t('shelfMetaTitle') };
}

async function loadShelfData() {
  const supabase = await createClient();

  const { user } = await getAuthenticatedPrincipal(supabase);
  const userId = user?.id;

  if (!userId) {
    return {
      subjects: [] as SubjectWithMetadata[],
      shelfItems: [] as NotebookShelfItem[],
    };
  }

  try {
    await ensurePresetSubjects(supabase, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to ensure preset subjects: ${message}`);
  }

  const [subjectsResult, shelfItems] = await Promise.all([
    supabase.rpc('get_subjects_with_metadata'),
    loadNotebookShelf(supabase, userId).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to load notebook shelf: ${message}`);
      return [] as NotebookShelfItem[];
    }),
  ]);

  return {
    subjects: prepareSubjectsForNotebookShelf(
      (subjectsResult.data || []) as SubjectWithMetadata[]
    ),
    shelfItems,
  };
}

export default async function SubjectsPage() {
  const { subjects, shelfItems } = await loadShelfData();

  return (
    <SubjectsPageClient
      initialSubjects={subjects}
      initialShelfItems={shelfItems}
    />
  );
}

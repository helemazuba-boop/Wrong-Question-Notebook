import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireUser } from '@/lib/supabase/requireUser';
import { loadTodos } from '@/lib/todos';
import type { SubjectWithMetadata } from '@/lib/types';
import TodosPageClient from './todos-page-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Navigation');
  return { title: t('todos') };
}

export default async function TodosPage() {
  const { user, supabase } = await requireUser();

  if (!user) {
    return <TodosPageClient initialTodos={[]} subjects={[]} />;
  }

  const [todos, subjectsResult] = await Promise.all([
    loadTodos(supabase, user.id, { status: 'all', limit: 100 }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to load todos: ${message}`);
      return [];
    }),
    supabase.rpc('get_subjects_with_metadata'),
  ]);

  return (
    <TodosPageClient
      initialTodos={todos}
      subjects={(subjectsResult.data || []) as SubjectWithMetadata[]}
    />
  );
}

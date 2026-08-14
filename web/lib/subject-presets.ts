import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { SubjectWithMetadata } from '@/lib/types';

export const PRESET_SUBJECTS = [
  { name: '语文', canonicalKey: 'chinese', color: 'rose', icon: 'BookOpen' },
  { name: '数学', canonicalKey: 'math', color: 'blue', icon: 'Calculator' },
  {
    name: '英语',
    canonicalKey: 'english',
    color: 'emerald',
    icon: 'Languages',
  },
  { name: '物理', canonicalKey: 'physics', color: 'purple', icon: 'Atom' },
  {
    name: '化学',
    canonicalKey: 'chemistry',
    color: 'orange',
    icon: 'Beaker',
  },
  {
    name: '生物',
    canonicalKey: 'biology',
    color: 'teal',
    icon: 'Microscope',
  },
  {
    name: '历史',
    canonicalKey: 'history',
    color: 'amber',
    icon: 'BookMarked',
  },
  {
    name: '地理',
    canonicalKey: 'geography',
    color: 'emerald',
    icon: 'Globe',
  },
  {
    name: '政治',
    canonicalKey: 'politics',
    color: 'purple',
    icon: 'GraduationCap',
  },
  {
    name: '信息技术',
    canonicalKey: 'information_technology',
    color: 'blue',
    icon: 'Code',
  },
  { name: '其他', canonicalKey: 'other', color: 'pink', icon: 'Lightbulb' },
  {
    name: '未分类',
    canonicalKey: null,
    color: 'amber',
    icon: 'NotebookPen',
  },
] as const;

export const DEFAULT_PRESET_SUBJECT_NAME = '未分类';

const presetOrder = new Map<string, number>(
  PRESET_SUBJECTS.map((subject, index) => [subject.name, index])
);

export function getPresetSubjectOrder(name: string): number {
  return presetOrder.get(name) ?? PRESET_SUBJECTS.length;
}

export function sortSubjectsByPresetOrder<T extends { name: string }>(
  subjects: T[]
): T[] {
  return [...subjects].sort((left, right) => {
    const leftOrder = getPresetSubjectOrder(left.name);
    const rightOrder = getPresetSubjectOrder(right.name);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name, 'zh-CN');
  });
}

export function findDefaultSubjectId(
  subjects: Array<{ id: string; name: string }>
): string {
  return (
    subjects.find(subject => subject.name === DEFAULT_PRESET_SUBJECT_NAME)
      ?.id ||
    subjects[0]?.id ||
    ''
  );
}

export async function ensurePresetSubjects(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('subjects')
    .select('name')
    .eq('user_id', userId);

  if (error) throw error;

  const existingNames = new Set((data || []).map(subject => subject.name));
  const missingSubjects = PRESET_SUBJECTS.filter(
    subject => !existingNames.has(subject.name)
  );

  if (missingSubjects.length === 0) return;

  const { error: insertError } = await supabase.from('subjects').insert(
    missingSubjects.map(subject => ({
      user_id: userId,
      name: subject.name,
      color: subject.color,
      icon: subject.icon,
    }))
  );

  if (insertError) throw insertError;
}

export function prepareSubjectsForNotebookShelf(
  subjects: SubjectWithMetadata[]
): SubjectWithMetadata[] {
  return sortSubjectsByPresetOrder(subjects);
}

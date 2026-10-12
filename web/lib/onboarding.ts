import type { SupabaseClient } from '@supabase/supabase-js';
import type { OnboardingStatus } from '@/lib/types';
export async function loadOnboardingStatus(
  client: SupabaseClient<any>,
  userId: string
): Promise<OnboardingStatus> {
  const profile = await client
    .from('user_profiles')
    .select('onboarding_scenario')
    .eq('id', userId)
    .single();
  if (profile.error) throw new Error('Onboarding profile is unavailable');
  const scenario = profile.data
    ?.onboarding_scenario as OnboardingStatus['scenario'];
  const empty = {
    scenario: scenario ?? null,
    hasContainer: false,
    hasContent: false,
    hasPracticed: false,
    containerHref: '/subjects',
    contentHref: '/subjects',
    practiceHref: '/subjects',
  };
  if (!scenario) return empty;
  if (scenario === 'problems') {
    const [sets, problems, reviewed, subject] = await Promise.all([
      client
        .from('problem_sets')
        .select('id', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at')
        .limit(1)
        .maybeSingle(),
      client
        .from('problems')
        .select('id,subject_id', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at')
        .limit(1)
        .maybeSingle(),
      client
        .from('problems')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .not('last_reviewed_date', 'is', null),
      client
        .from('subjects')
        .select('id')
        .eq('user_id', userId)
        .order('created_at')
        .limit(1)
        .maybeSingle(),
    ]);
    if ([sets, problems, reviewed, subject].some(result => result.error))
      throw new Error('Onboarding content is unavailable');
    return {
      ...empty,
      hasContainer: (sets.count ?? 0) > 0,
      hasContent: (problems.count ?? 0) > 0,
      hasPracticed: (reviewed.count ?? 0) > 0,
      contentHref: subject.data
        ? `/subjects/${subject.data.id}/problems`
        : '/subjects',
      practiceHref: problems.data
        ? `/subjects/${problems.data.subject_id}/problems/${problems.data.id}/review`
        : '/subjects',
    };
  }
  if (scenario === 'notes') {
    const [notebooks, notes, read] = await Promise.all([
      client
        .from('notebooks')
        .select('id', { count: 'exact' })
        .eq('user_id', userId)
        .is('archived_at', null)
        .order('created_at')
        .limit(1)
        .maybeSingle(),
      client
        .from('notebook_notes')
        .select('id,notebook_id', { count: 'exact' })
        .eq('user_id', userId)
        .is('archived_at', null)
        .order('created_at')
        .limit(1)
        .maybeSingle(),
      client
        .from('note_read_state')
        .select('note_id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gt('completed_count', 0),
    ]);
    if ([notebooks, notes, read].some(result => result.error))
      throw new Error('Onboarding notes are unavailable');
    const target = notebooks.data
      ? `/notebooks/${notebooks.data.id}`
      : '/notebooks';
    return {
      ...empty,
      hasContainer: (notebooks.count ?? 0) > 0,
      hasContent: (notes.count ?? 0) > 0,
      hasPracticed: (read.count ?? 0) > 0,
      containerHref: '/subjects',
      contentHref: target,
      practiceHref: notes.data
        ? `/notebooks/${notes.data.notebook_id}`
        : target,
    };
  }
  const [decks, events, sessions, completed] = await Promise.all([
    client
      .from('word_decks')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)
      .is('archived_at', null)
      .order('created_at')
      .limit(1)
      .maybeSingle(),
    client
      .from('word_review_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId),
    client
      .from('study_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('domain', 'word'),
    client
      .from('study_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('domain', 'word')
      .eq('status', 'completed'),
  ]);
  if ([decks, events, sessions, completed].some(result => result.error))
    throw new Error('Onboarding words are unavailable');
  // A global system dictionary is not evidence that this user chose a deck.
  const hasCompletedSession = (completed.count ?? 0) > 0;
  return {
    ...empty,
    hasContainer: (decks.count ?? 0) > 0 || (sessions.count ?? 0) > 0,
    hasContent: (events.count ?? 0) > 0,
    hasPracticed: hasCompletedSession,
    containerHref: '/words',
    contentHref: '/words/study/new',
    practiceHref: '/words/study/new',
  };
}

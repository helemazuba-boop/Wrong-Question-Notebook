import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/lib/database.types';

const initialIdeaHeadSchema = z
  .object({
    revision_id: z.uuid(),
    revision: z.number().int().positive(),
    revision_kind: z.enum(['set', 'clear']),
    idea: z.string().nullable(),
  })
  .superRefine((head, context) => {
    if (
      (head.revision_kind === 'set' && head.idea === null) ||
      (head.revision_kind === 'clear' && head.idea !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Initial idea head has inconsistent set/clear state',
      });
    }
  });

export type ProblemInitialIdeaHead = z.infer<typeof initialIdeaHeadSchema>;

type InitialIdeaClient = SupabaseClient<Database>;

export async function readProblemInitialIdea(
  supabase: InitialIdeaClient,
  userId: string,
  problemId: string
): Promise<ProblemInitialIdeaHead | null> {
  const { data: context, error: contextError } = await supabase
    .from('problem_user_contexts')
    .select('current_initial_idea_revision_id')
    .eq('user_id', userId)
    .eq('problem_id', problemId)
    .maybeSingle();

  if (contextError) {
    throw new Error(
      `Failed to read Problem user context: ${contextError.message}`
    );
  }

  const revisionId = context?.current_initial_idea_revision_id;
  if (!revisionId) return null;

  const { data: revision, error: revisionError } = await supabase
    .from('problem_initial_idea_revisions')
    .select('id, revision, revision_kind, idea')
    .eq('id', revisionId)
    .eq('user_id', userId)
    .eq('problem_id', problemId)
    .single();

  if (revisionError || !revision) {
    throw new Error(
      `Failed to read current initial idea revision: ${revisionError?.message ?? 'missing revision'}`
    );
  }

  return initialIdeaHeadSchema.parse({
    revision_id: revision.id,
    revision: revision.revision,
    revision_kind: revision.revision_kind,
    idea: revision.idea,
  });
}

export async function readProblemInitialIdeas(
  supabase: InitialIdeaClient,
  userId: string,
  problemIds: string[]
): Promise<Map<string, ProblemInitialIdeaHead>> {
  const uniqueProblemIds = [...new Set(problemIds)];
  if (uniqueProblemIds.length === 0) return new Map();

  const { data: contexts, error: contextsError } = await supabase
    .from('problem_user_contexts')
    .select('problem_id, current_initial_idea_revision_id')
    .eq('user_id', userId)
    .in('problem_id', uniqueProblemIds);

  if (contextsError) {
    throw new Error(
      `Failed to read Problem user contexts: ${contextsError.message}`
    );
  }

  const revisionIds = (contexts ?? [])
    .map(context => context.current_initial_idea_revision_id)
    .filter((id): id is string => id !== null);
  if (revisionIds.length === 0) return new Map();

  const { data: revisions, error: revisionsError } = await supabase
    .from('problem_initial_idea_revisions')
    .select('id, problem_id, revision, revision_kind, idea')
    .eq('user_id', userId)
    .in('id', revisionIds);

  if (revisionsError) {
    throw new Error(
      `Failed to read current initial idea revisions: ${revisionsError.message}`
    );
  }

  const revisionsById = new Map(
    (revisions ?? []).map(revision => [revision.id, revision])
  );
  const heads = new Map<string, ProblemInitialIdeaHead>();

  for (const context of contexts ?? []) {
    const revisionId = context.current_initial_idea_revision_id;
    if (!revisionId) continue;
    const revision = revisionsById.get(revisionId);
    if (!revision || revision.problem_id !== context.problem_id) {
      throw new Error(
        'Current initial idea revision is missing or inconsistent'
      );
    }
    heads.set(
      context.problem_id,
      initialIdeaHeadSchema.parse({
        revision_id: revision.id,
        revision: revision.revision,
        revision_kind: revision.revision_kind,
        idea: revision.idea,
      })
    );
  }

  return heads;
}

export async function setProblemInitialIdea(
  supabase: InitialIdeaClient,
  problemId: string,
  idea: string | null
): Promise<ProblemInitialIdeaHead> {
  const { data, error } = await supabase.rpc('set_problem_initial_idea', {
    p_problem_id: problemId,
    p_revision_kind: idea === null ? 'clear' : 'set',
    p_idea: idea,
  });

  if (error) {
    throw new Error(`Failed to save initial idea: ${error.message}`);
  }

  const result = z
    .object({
      revision_id: z.uuid(),
      revision: z.number().int().positive(),
      revision_kind: z.enum(['set', 'clear']),
      idea: z.string().nullable(),
    })
    .parse(data);

  return initialIdeaHeadSchema.parse(result);
}

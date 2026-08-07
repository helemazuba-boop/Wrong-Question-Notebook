import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/lib/database.types';

const registryRevisionSchema = z.object({
  id: z.number().int().positive(),
  source_sha: z.string().regex(/^[0-9a-f]{40}$/),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  schema_version: z.number().int().positive(),
});

const markSchema = z.object({
  stable_key: z.string(),
  name: z.string(),
  kind: z.enum(['knowledge', 'skill']),
  subject: z.string(),
  status: z.enum(['active', 'deprecated']),
  parent: z.string().nullable(),
});

const markEdgeSchema = z.object({
  part_index: z.number().int().min(1).max(10).nullable(),
  mark: markSchema,
});

const unresolvedSchema = z.object({
  part_index: z.number().int().min(1).max(10).nullable(),
  role: z.enum(['target', 'required']),
  kind: z.enum(['knowledge', 'skill']),
  reason: z.enum([
    'no_registry_match',
    'registry_empty',
    'subject_unmapped',
    'insufficient_problem_context',
    'invalid_model_output',
  ]),
});

export const ProblemSemanticsSchema = z.object({
  registry_revision: registryRevisionSchema.nullable(),
  semantic_revision: z.number().int().positive().nullable(),
  annotation_status: z.enum(['pending', 'resolved', 'unresolved', 'failed']),
  targets: z.array(markEdgeSchema),
  required: z.object({
    knowledge: z.array(markEdgeSchema),
    skills: z.array(markEdgeSchema),
  }),
  unresolved: z.array(unresolvedSchema),
});

export type ProblemSemantics = z.infer<typeof ProblemSemanticsSchema>;

export async function readProblemSemantics(
  supabase: SupabaseClient<Database>,
  problemId: string
): Promise<ProblemSemantics> {
  const { data, error } = await supabase.rpc('get_problem_semantics', {
    p_problem_id: problemId,
  });
  if (error)
    throw new Error(`Failed to read Problem semantics: ${error.message}`);
  return ProblemSemanticsSchema.parse(data);
}

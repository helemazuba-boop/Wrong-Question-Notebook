import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database, Json } from '@/lib/database.types';

const isoTimestampSchema = z.iso.datetime({ offset: true });

export const ProblemMarkAnnotationClaimSchema = z
  .object({
    problem_id: z.uuid(),
    semantic_revision: z.number().int().positive(),
    lease_token: z.uuid(),
    lease_until: isoTimestampSchema,
    attempt_count: z.number().int().positive(),
  })
  .strict();

export const ProblemMarkAnnotationClaimsSchema = z.array(
  ProblemMarkAnnotationClaimSchema
);

export type ProblemMarkAnnotationClaim = z.infer<
  typeof ProblemMarkAnnotationClaimSchema
>;

export interface ProblemMarkRunCommitInput {
  runId: string;
  leaseToken: string;
  objectiveSnapshotHash: string;
  queryHash: string;
  embeddingProfileId: string;
  queryTemplateVersion: string;
  retrieverVersion: string;
  markingModel: string;
  markingPromptVersion: string;
  skillResolution: 'selected' | 'no_applicable' | 'unresolved';
  skillCandidateKeys: string[];
  assignments: unknown[];
  unresolved: unknown[];
  retrievalDebug: Record<string, unknown>;
}

export async function claimProblemMarkAnnotations(
  supabase: SupabaseClient<Database>,
  limit = 10,
  leaseSeconds = 120
): Promise<ProblemMarkAnnotationClaim[]> {
  const { data, error } = await supabase.rpc('claim_problem_mark_annotations', {
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    throw new Error(
      `Unable to claim Problem Mark annotations: ${error.message}`
    );
  }
  return ProblemMarkAnnotationClaimsSchema.parse(data);
}

export async function claimProblemMarkAnnotation(
  supabase: SupabaseClient<Database>,
  problemId: string,
  leaseSeconds = 120
): Promise<ProblemMarkAnnotationClaim | null> {
  const { data, error } = await supabase.rpc('claim_problem_mark_annotation', {
    p_problem_id: problemId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    throw new Error(
      `Unable to claim Problem Mark annotation: ${error.message}`
    );
  }
  if (data === null) return null;
  return ProblemMarkAnnotationClaimSchema.parse(data);
}

export async function prepareProblemMarkAnnotation(
  supabase: SupabaseClient<Database>,
  claim: ProblemMarkAnnotationClaim
): Promise<unknown> {
  const { data, error } = await supabase.rpc(
    'prepare_problem_mark_annotation',
    {
      p_problem_id: claim.problem_id,
      p_semantic_revision: claim.semantic_revision,
      p_lease_token: claim.lease_token,
    }
  );
  if (error) {
    throw new Error(
      `Unable to prepare Problem Mark annotation: ${error.message}`
    );
  }
  return data;
}

export async function commitProblemMarkAnnotationRun(
  supabase: SupabaseClient<Database>,
  input: ProblemMarkRunCommitInput
): Promise<unknown> {
  const { data, error } = await supabase.rpc(
    'commit_problem_mark_annotation_run',
    {
      p_run_id: input.runId,
      p_lease_token: input.leaseToken,
      p_objective_snapshot_hash: input.objectiveSnapshotHash,
      p_query_hash: input.queryHash,
      p_embedding_profile_id: input.embeddingProfileId,
      p_query_template_version: input.queryTemplateVersion,
      p_retriever_version: input.retrieverVersion,
      p_marking_model: input.markingModel,
      p_marking_prompt_version: input.markingPromptVersion,
      p_skill_resolution: input.skillResolution,
      p_skill_candidate_keys: input.skillCandidateKeys as unknown as Json,
      p_assignments: input.assignments as unknown as Json,
      p_unresolved: input.unresolved as unknown as Json,
      p_retrieval_debug: input.retrievalDebug as unknown as Json,
    }
  );
  if (error) {
    throw new Error(
      `Unable to commit Problem Mark annotation: ${error.message}`
    );
  }
  return data;
}

export async function failProblemMarkAnnotationRun(
  supabase: SupabaseClient<Database>,
  runId: string,
  leaseToken: string,
  errorCode: string
): Promise<void> {
  const { error } = await supabase.rpc('fail_problem_mark_annotation_run', {
    p_run_id: runId,
    p_lease_token: leaseToken,
    p_error_code: errorCode,
  });
  if (error) {
    throw new Error(`Unable to fail Problem Mark annotation: ${error.message}`);
  }
}

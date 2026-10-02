import { z } from 'zod';
import type { ProblemCandidateDraft } from '@/lib/problem-ingestion';

export const PROBLEM_INGESTION_CANDIDATE_ASSET_MAX_COUNT = 20;

export const ProblemIngestionCandidateAssetSchema = z
  .object({
    path: z.string().min(1).max(1000),
    name: z.string().min(1).max(255),
    part_id: z.string().min(1).max(64).nullable().default(null),
  })
  .strict();

export const ProblemIngestionCandidateAssetsSchema = z
  .array(ProblemIngestionCandidateAssetSchema)
  .max(PROBLEM_INGESTION_CANDIDATE_ASSET_MAX_COUNT)
  .refine(
    assets => new Set(assets.map(asset => asset.path)).size === assets.length,
    {
      message: 'Asset paths must be unique',
    }
  );

export const UpdateProblemIngestionCandidateSchema = z
  .object({
    assets: ProblemIngestionCandidateAssetsSchema.optional(),
    solution_assets: ProblemIngestionCandidateAssetsSchema.optional(),
    status: z.enum(['pending', 'skipped']).optional(),
  })
  .strict()
  .refine(
    value =>
      value.assets !== undefined ||
      value.solution_assets !== undefined ||
      value.status !== undefined,
    { message: 'No candidate fields were provided' }
  );

export const AcceptProblemIngestionCandidatesSchema = z
  .object({
    question_ids: z.array(z.string().min(1).max(64)).min(1).max(20),
  })
  .strict()
  .refine(
    value => new Set(value.question_ids).size === value.question_ids.length,
    { message: 'Question IDs must be unique' }
  );

export type ProblemIngestionCandidateAsset = z.infer<
  typeof ProblemIngestionCandidateAssetSchema
>;

export interface ProblemIngestionWorkspaceCandidate {
  question_id: string;
  position: number;
  problem_id: string;
  status: 'pending' | 'skipped' | 'accepted';
  assets: ProblemIngestionCandidateAsset[];
  solution_assets: ProblemIngestionCandidateAsset[];
  accepted_problem_id: string | null;
  draft: ProblemCandidateDraft;
}

export interface ProblemIngestionWorkspace {
  id: string;
  subject_id: string | null;
  schema_version: 'wqn.problem-ingestion.v1';
  status: 'complete' | 'partial';
  created_at: string;
  warnings: string[];
  candidates: ProblemIngestionWorkspaceCandidate[];
}

export interface ProblemIngestionWorkspaceSummary {
  id: string;
  subject_id: string | null;
  status: string;
  created_at: string;
  question_count: number;
  pending_count: number;
  accepted_count: number;
}

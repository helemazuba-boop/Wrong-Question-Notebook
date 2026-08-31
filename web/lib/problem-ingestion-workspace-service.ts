import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import {
  duplicateProblemIngestionQuestionIds,
  ProblemIngestionDocumentSchema,
  problemCandidatesFromIngestion,
  PROBLEM_INGESTION_IMPORT_MAX_QUESTIONS,
  type ProblemIngestionDocument,
} from '@/lib/problem-ingestion';
import {
  ProblemIngestionCandidateAssetsSchema,
  type ProblemIngestionCandidateAsset,
  type ProblemIngestionWorkspace,
  type ProblemIngestionWorkspaceSummary,
} from '@/lib/problem-ingestion-workspace-contract';
import {
  persistProblemIngestion,
  ProblemExtractionServiceError,
} from '@/lib/problem-extraction-service';
import { extractionContent, storedPart } from '@/lib/problem-creation-service';
import { deriveProblemImageAssets } from '@/lib/problem-image-service';
import { checkContentLimit } from '@/lib/content-limits';
import { CONTENT_LIMIT_CONSTANTS } from '@/lib/constants';
import { deleteProblemFiles } from '@/lib/storage/delete';
import { revalidateProblemComprehensive } from '@/lib/cache-invalidation';
import { wakeProblemMarkAnnotation } from '@/lib/problem-marks/wake';

export class ProblemIngestionWorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ProblemIngestionWorkspaceError';
  }
}

function databaseError(message: string): ProblemIngestionWorkspaceError {
  return new ProblemIngestionWorkspaceError('database_error', message, 500);
}

function assertImportable(document: ProblemIngestionDocument): void {
  const count = document.questions.length;
  if (count < 1) {
    throw new ProblemIngestionWorkspaceError(
      'no_problem_detected',
      'The ingestion document contains no recognized problems',
      422
    );
  }
  if (count > PROBLEM_INGESTION_IMPORT_MAX_QUESTIONS) {
    throw new ProblemIngestionWorkspaceError(
      'too_many_problems_detected',
      `Detected ${count} independent problems; split the import into batches of at most ${PROBLEM_INGESTION_IMPORT_MAX_QUESTIONS}`,
      422,
      { count, max: PROBLEM_INGESTION_IMPORT_MAX_QUESTIONS }
    );
  }
  const duplicateQuestionIds = duplicateProblemIngestionQuestionIds(document);
  if (duplicateQuestionIds.length > 0) {
    throw new ProblemIngestionWorkspaceError(
      'duplicate_question_ids',
      'Problem ingestion question IDs must be unique',
      422,
      { question_ids: duplicateQuestionIds }
    );
  }
}

function candidateAssets(value: Json): ProblemIngestionCandidateAsset[] {
  const parsed = ProblemIngestionCandidateAssetsSchema.safeParse(value);
  if (!parsed.success) {
    throw databaseError('Stored ingestion candidate assets are invalid');
  }
  return parsed.data;
}

function assertCandidateAssetPaths(
  userId: string,
  problemId: string,
  role: 'problem' | 'solution',
  assets: ProblemIngestionCandidateAsset[]
): void {
  const prefix = `user/${userId}/problems/${problemId}/${role}/`;
  if (
    assets.some(
      asset =>
        !asset.path.startsWith(prefix) ||
        asset.path.includes('/../') ||
        asset.path.includes('/./') ||
        asset.path.slice(prefix.length).includes('/')
    )
  ) {
    throw new ProblemIngestionWorkspaceError(
      'invalid_asset_path',
      'A candidate asset does not belong to this question draft',
      403
    );
  }
}

async function loadIngestion(
  supabase: SupabaseClient<Database>,
  userId: string,
  ingestionId: string
) {
  const { data, error } = await supabase
    .from('problem_ingestions')
    .select(
      'id, subject_id, schema_version, status, created_at, document, user_id'
    )
    .eq('id', ingestionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw databaseError(error.message);
  if (!data) {
    throw new ProblemIngestionWorkspaceError(
      'ingestion_not_found',
      'Problem ingestion was not found',
      404
    );
  }
  const parsed = ProblemIngestionDocumentSchema.safeParse(data.document);
  if (!parsed.success) {
    throw databaseError('Stored problem ingestion document is invalid');
  }
  assertImportable(parsed.data);
  return { row: data, document: parsed.data };
}

export async function getProblemIngestionWorkspace(
  supabase: SupabaseClient<Database>,
  userId: string,
  ingestionId: string
): Promise<ProblemIngestionWorkspace> {
  const { row, document } = await loadIngestion(supabase, userId, ingestionId);
  const [
    { data: candidates, error: candidateError },
    { data: links, error: linkError },
  ] = await Promise.all([
    supabase
      .from('problem_ingestion_candidates')
      .select('*')
      .eq('ingestion_id', ingestionId)
      .eq('user_id', userId)
      .order('position'),
    supabase
      .from('problem_ingestion_problem_links')
      .select('question_id, problem_id')
      .eq('ingestion_id', ingestionId)
      .eq('user_id', userId),
  ]);
  if (candidateError || linkError) {
    throw databaseError(
      candidateError?.message || linkError?.message || 'Workspace read failed'
    );
  }
  const drafts = new Map(
    problemCandidatesFromIngestion(document).map(draft => [
      draft.question_id,
      draft,
    ])
  );
  const linksByQuestion = new Map(
    (links ?? []).map(link => [link.question_id, link.problem_id])
  );
  if ((candidates ?? []).length !== document.questions.length) {
    throw databaseError('Problem ingestion candidates are incomplete');
  }
  return {
    id: row.id,
    subject_id: row.subject_id,
    schema_version: 'wqn.problem-ingestion.v1',
    status: document.status,
    created_at: row.created_at,
    warnings: document.warnings,
    candidates: (candidates ?? []).map(candidate => {
      const draft = drafts.get(candidate.question_id);
      if (!draft) {
        throw databaseError(
          `Candidate ${candidate.question_id} is missing from the ingestion document`
        );
      }
      return {
        question_id: candidate.question_id,
        position: candidate.position,
        problem_id: candidate.problem_id,
        status: candidate.status as 'pending' | 'skipped' | 'accepted',
        assets: candidateAssets(candidate.assets),
        solution_assets: candidateAssets(candidate.solution_assets),
        accepted_problem_id: linksByQuestion.get(candidate.question_id) ?? null,
        draft,
      };
    }),
  };
}

export async function listProblemIngestionWorkspaces(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId?: string | null
): Promise<ProblemIngestionWorkspaceSummary[]> {
  let query = supabase
    .from('problem_ingestions')
    .select('id, subject_id, status, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (subjectId) query = query.eq('subject_id', subjectId);
  const { data: ingestions, error } = await query;
  if (error) throw databaseError(error.message);
  if (!ingestions?.length) return [];
  const { data: candidates, error: candidateError } = await supabase
    .from('problem_ingestion_candidates')
    .select('ingestion_id, status')
    .eq('user_id', userId)
    .in(
      'ingestion_id',
      ingestions.map(ingestion => ingestion.id)
    );
  if (candidateError) throw databaseError(candidateError.message);
  return ingestions
    .map(ingestion => {
      const rows = (candidates ?? []).filter(
        candidate => candidate.ingestion_id === ingestion.id
      );
      return {
        ...ingestion,
        question_count: rows.length,
        pending_count: rows.filter(row => row.status !== 'accepted').length,
        accepted_count: rows.filter(row => row.status === 'accepted').length,
      };
    })
    .filter(summary => summary.question_count > 0 && summary.pending_count > 0);
}

export async function persistExternalProblemIngestion(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId: string,
  input: unknown
): Promise<ProblemIngestionWorkspace> {
  const parsed = ProblemIngestionDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProblemIngestionWorkspaceError(
      'invalid_ingestion_document',
      issue
        ? `${issue.path.join('.') || '(root)'}: ${issue.message}`
        : 'Invalid problem ingestion document',
      400
    );
  }
  assertImportable(parsed.data);
  const { data: subject, error: subjectError } = await supabase
    .from('subjects')
    .select('id')
    .eq('id', subjectId)
    .eq('user_id', userId)
    .maybeSingle();
  if (subjectError) throw databaseError(subjectError.message);
  if (!subject) {
    throw new ProblemIngestionWorkspaceError(
      'subject_not_found',
      'Subject was not found',
      404
    );
  }
  let ingestionId: string;
  try {
    ingestionId = await persistProblemIngestion(
      supabase,
      userId,
      subjectId,
      parsed.data,
      { provider: 'external', providerModel: 'user-supplied-structured-json' }
    );
  } catch (error) {
    if (error instanceof ProblemExtractionServiceError) {
      throw new ProblemIngestionWorkspaceError(
        error.code,
        error.message,
        error.status,
        error.details
      );
    }
    throw error;
  }
  return getProblemIngestionWorkspace(supabase, userId, ingestionId);
}

export async function updateProblemIngestionCandidate(
  supabase: SupabaseClient<Database>,
  userId: string,
  ingestionId: string,
  questionId: string,
  update: {
    assets?: ProblemIngestionCandidateAsset[];
    solution_assets?: ProblemIngestionCandidateAsset[];
    status?: 'pending' | 'skipped';
  }
): Promise<ProblemIngestionWorkspace> {
  const { data: candidate, error } = await supabase
    .from('problem_ingestion_candidates')
    .select('*')
    .eq('ingestion_id', ingestionId)
    .eq('question_id', questionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw databaseError(error.message);
  if (!candidate) {
    throw new ProblemIngestionWorkspaceError(
      'candidate_not_found',
      'Problem ingestion candidate was not found',
      404
    );
  }
  if (candidate.status === 'accepted') {
    throw new ProblemIngestionWorkspaceError(
      'candidate_already_accepted',
      'Accepted candidates are immutable',
      409
    );
  }
  if (update.assets) {
    assertCandidateAssetPaths(
      userId,
      candidate.problem_id,
      'problem',
      update.assets
    );
  }
  if (update.solution_assets) {
    assertCandidateAssetPaths(
      userId,
      candidate.problem_id,
      'solution',
      update.solution_assets
    );
  }
  const payload = {
    ...(update.assets ? { assets: update.assets as unknown as Json } : {}),
    ...(update.solution_assets
      ? { solution_assets: update.solution_assets as unknown as Json }
      : {}),
    ...(update.status ? { status: update.status } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error: updateError } = await supabase
    .from('problem_ingestion_candidates')
    .update(payload)
    .eq('ingestion_id', ingestionId)
    .eq('question_id', questionId)
    .eq('user_id', userId);
  if (updateError) throw databaseError(updateError.message);
  return getProblemIngestionWorkspace(supabase, userId, ingestionId);
}

function problemAssets(assets: ProblemIngestionCandidateAsset[]) {
  return assets.map(asset => ({ path: asset.path, kind: 'image' as const }));
}

function sourceForCandidate(
  ingestionId: string,
  draft: ProblemIngestionWorkspace['candidates'][number]['draft']
): Json {
  return {
    ingestion_id: ingestionId,
    ingestion_schema_version: 'wqn.problem-ingestion.v1',
    ingestion_question_id: draft.question_id,
    source_region_ids: draft.source_region_ids,
    visual_region_ids: draft.visual_region_ids,
    ...(draft.number_label?.trim()
      ? { question_no: draft.number_label.trim().slice(0, 16) }
      : {}),
  };
}

export async function acceptProblemIngestionCandidates(
  supabase: SupabaseClient<Database>,
  userId: string,
  ingestionId: string,
  questionIds: string[]
): Promise<ProblemIngestionWorkspace> {
  const workspace = await getProblemIngestionWorkspace(
    supabase,
    userId,
    ingestionId
  );
  if (!workspace.subject_id) {
    throw new ProblemIngestionWorkspaceError(
      'subject_required',
      'A subject is required before candidates can be accepted',
      422
    );
  }
  const selected = questionIds.map(questionId => {
    const candidate = workspace.candidates.find(
      item => item.question_id === questionId
    );
    if (!candidate) {
      throw new ProblemIngestionWorkspaceError(
        'candidate_not_found',
        `Candidate ${questionId} was not found`,
        404
      );
    }
    return candidate;
  });
  const skipped = selected.filter(candidate => candidate.status === 'skipped');
  if (skipped.length > 0) {
    throw new ProblemIngestionWorkspaceError(
      'candidate_skipped',
      'Restore skipped candidates before importing them',
      409,
      { question_ids: skipped.map(candidate => candidate.question_id) }
    );
  }
  const pending = selected.filter(candidate => candidate.status === 'pending');
  if (pending.length === 0) return workspace;
  const missingRequiredAssets = pending.filter(
    candidate => candidate.draft.suggest_image_asset && !candidate.assets.length
  );
  if (missingRequiredAssets.length > 0) {
    throw new ProblemIngestionWorkspaceError(
      'image_asset_required',
      'Upload a problem image for each selected question that depends on visual content',
      422,
      {
        question_ids: missingRequiredAssets.map(
          candidate => candidate.question_id
        ),
      }
    );
  }

  const problemIds = pending.map(candidate => candidate.problem_id);
  const { data: existing, error: existingError } = await supabase
    .from('problems')
    .select('id, source')
    .eq('user_id', userId)
    .in('id', problemIds);
  if (existingError) throw databaseError(existingError.message);
  for (const problem of existing ?? []) {
    const source =
      problem.source &&
      typeof problem.source === 'object' &&
      !Array.isArray(problem.source)
        ? problem.source
        : {};
    if (
      source.ingestion_id !== ingestionId ||
      !pending.some(
        candidate =>
          candidate.problem_id === problem.id &&
          candidate.question_id === source.ingestion_question_id
      )
    ) {
      throw new ProblemIngestionWorkspaceError(
        'reserved_problem_id_conflict',
        'A reserved candidate Problem ID is already in use',
        409
      );
    }
  }
  const existingIds = new Set((existing ?? []).map(problem => problem.id));
  const missing = pending.filter(
    candidate => !existingIds.has(candidate.problem_id)
  );
  if (missing.length > 0) {
    const problemLimit = await checkContentLimit(
      userId,
      CONTENT_LIMIT_CONSTANTS.RESOURCE_TYPES.PROBLEMS_PER_SUBJECT,
      { subjectId: workspace.subject_id }
    );
    if (problemLimit.remaining < missing.length) {
      throw new ProblemIngestionWorkspaceError(
        'problem_limit_reached',
        `Only ${problemLimit.remaining} more problems can be created in this subject`,
        403,
        problemLimit
      );
    }
    if (
      missing.some(
        candidate =>
          candidate.assets.length > 0 || candidate.solution_assets.length > 0
      )
    ) {
      const storageLimit = await checkContentLimit(
        userId,
        CONTENT_LIMIT_CONSTANTS.RESOURCE_TYPES.STORAGE_BYTES
      );
      if (!storageLimit.allowed) {
        throw new ProblemIngestionWorkspaceError(
          'storage_limit_reached',
          'Storage limit reached',
          403,
          storageLimit
        );
      }
    }
  }
  const rows = await Promise.all(
    missing.map(async candidate => {
      assertCandidateAssetPaths(
        userId,
        candidate.problem_id,
        'problem',
        candidate.assets
      );
      assertCandidateAssetPaths(
        userId,
        candidate.problem_id,
        'solution',
        candidate.solution_assets
      );
      const extraction = {
        title: candidate.draft.title,
        content: candidate.draft.content,
        parts: candidate.draft.parts,
        suggest_image_asset: candidate.draft.suggest_image_asset,
        new_tag_names: candidate.draft.new_tag_names,
        confidence: candidate.draft.confidence,
      };
      const [assets, solutionAssets] = await Promise.all([
        deriveProblemImageAssets(problemAssets(candidate.assets)),
        deriveProblemImageAssets(problemAssets(candidate.solution_assets)),
      ]);
      return {
        id: candidate.problem_id,
        user_id: userId,
        subject_id: workspace.subject_id!,
        title: candidate.draft.title.trim().slice(0, 200),
        content: extractionContent(extraction),
        parts: candidate.draft.parts.map(part =>
          storedPart(part, candidate.draft.parts.length)
        ) as unknown as Json,
        source: sourceForCandidate(ingestionId, candidate.draft),
        is_optional: false,
        status: 'needs_review' as const,
        assets: assets as unknown as Json,
        solution_text: '',
        solution_assets: solutionAssets as unknown as Json,
      };
    })
  );
  if (rows.length > 0) {
    const { error: insertError } = await supabase.from('problems').insert(rows);
    if (insertError) {
      // A concurrent identical accept may have won. Only treat it as a replay
      // when every reserved Problem ID now exists for this owner.
      const { data: replayRows, error: replayError } = await supabase
        .from('problems')
        .select('id, source')
        .eq('user_id', userId)
        .in(
          'id',
          rows.map(row => row.id)
        );
      const matchingReplay = (replayRows ?? []).every(problem => {
        const source =
          problem.source &&
          typeof problem.source === 'object' &&
          !Array.isArray(problem.source)
            ? problem.source
            : {};
        return missing.some(
          candidate =>
            candidate.problem_id === problem.id &&
            source.ingestion_id === ingestionId &&
            source.ingestion_question_id === candidate.question_id
        );
      });
      if (
        replayError ||
        replayRows?.length !== rows.length ||
        !matchingReplay
      ) {
        throw databaseError(insertError.message);
      }
    }
  }

  const now = new Date().toISOString();
  const { error: scheduleError } = await supabase
    .from('review_schedule')
    .upsert(
      pending.map(candidate => ({
        user_id: userId,
        problem_id: candidate.problem_id,
        next_review_at: now,
        interval_days: 1,
      })),
      { onConflict: 'user_id,problem_id' }
    );
  if (scheduleError) throw databaseError(scheduleError.message);

  const { error: candidateError } = await supabase
    .from('problem_ingestion_candidates')
    .update({ status: 'accepted', updated_at: now })
    .eq('ingestion_id', ingestionId)
    .eq('user_id', userId)
    .in(
      'question_id',
      pending.map(candidate => candidate.question_id)
    );
  if (candidateError) throw databaseError(candidateError.message);

  for (const candidate of pending) {
    wakeProblemMarkAnnotation(candidate.problem_id);
  }
  await Promise.all(
    pending.map(candidate =>
      revalidateProblemComprehensive(
        candidate.problem_id,
        workspace.subject_id!,
        userId
      )
    )
  );
  return getProblemIngestionWorkspace(supabase, userId, ingestionId);
}

export async function deleteProblemIngestionWorkspace(
  supabase: SupabaseClient<Database>,
  userId: string,
  ingestionId: string
): Promise<void> {
  const workspace = await getProblemIngestionWorkspace(
    supabase,
    userId,
    ingestionId
  );
  if (workspace.candidates.some(candidate => candidate.status === 'accepted')) {
    throw new ProblemIngestionWorkspaceError(
      'ingestion_has_accepted_problems',
      'An ingestion with accepted Problems cannot be discarded',
      409
    );
  }
  const { error } = await supabase
    .from('problem_ingestions')
    .delete()
    .eq('id', ingestionId)
    .eq('user_id', userId);
  if (error) throw databaseError(error.message);
  await Promise.all(
    workspace.candidates.map(candidate =>
      deleteProblemFiles(supabase, userId, candidate.problem_id)
    )
  );
}

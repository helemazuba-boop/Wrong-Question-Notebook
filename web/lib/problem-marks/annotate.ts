import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createAIClient, type AIClient } from '@/lib/ai/client';
import { AI_CONSTANTS } from '@/lib/constants';
import type { Database } from '@/lib/database.types';
import {
  claimProblemMarkAnnotation,
  commitProblemMarkAnnotationRun,
  failProblemMarkAnnotationRun,
  prepareProblemMarkAnnotation,
  type ProblemMarkAnnotationClaim,
} from '@/lib/problem-marks/lifecycle';
import {
  KnowledgeRegistryLockSchema,
  type KnowledgeRegistryLock,
} from '@/lib/problem-marks/registry-artifact';

const assignmentSchema = z
  .object({
    mark_key: z.string(),
    role: z.enum(['target', 'required']),
    part_index: z.number().int().min(1).max(10).nullable(),
  })
  .strict();
const unresolvedSchema = z
  .object({
    role: z.enum(['target', 'required']),
    kind: z.enum(['knowledge', 'skill']),
    part_index: z.number().int().min(1).max(10).nullable(),
    reason: z.literal('no_registry_match'),
  })
  .strict();
const modelResultSchema = z
  .object({
    assignments: z.array(assignmentSchema),
    unresolved: z.array(unresolvedSchema),
  })
  .strict();

const candidateSchema = z
  .object({
    stable_key: z.string(),
    name: z.string(),
    kind: z.enum(['knowledge', 'skill']),
    subject: z.string(),
    aliases: z.array(z.string()),
    description: z.string().nullable(),
    parent: z.string().nullable(),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  })
  .strict();
const preparedContextSchema = z
  .object({
    run_id: z.uuid(),
    lease_token: z.uuid(),
    problem_id: z.uuid(),
    semantic_revision: z.number().int().positive(),
    annotation_status: z.enum(['pending', 'resolved', 'unresolved', 'failed']),
    title: z.string(),
    content: z.string().nullable(),
    parts: z.unknown(),
    solution_text: z.string().nullable(),
    assets: z.unknown(),
    solution_assets: z.unknown(),
    subject_key: z.string().nullable(),
    registry_revision_id: z.number().int().positive().nullable(),
    registry_source_sha: z.string().nullable(),
    registry_content_sha256: z.string().nullable(),
    registry_schema_version: z.number().int().nullable(),
    candidates: z.array(candidateSchema),
  })
  .strict();
const runEnvelopeSchema = z
  .object({ run_id: z.uuid(), lease_token: z.uuid() })
  .passthrough();

const COMPATIBILITY_RETRIEVER_VERSION = 'subject-candidates-v0';
const COMPATIBILITY_EMBEDDING_PROFILE = 'none:subject-candidates-v0';
const SKILL_QUERY_TEMPLATE_VERSION = 'skill-question-v1';
const MARKING_PROMPT_VERSION = 'objective-problem-marking-v1';

type Context = z.infer<typeof preparedContextSchema>;
type Assignment = z.infer<typeof assignmentSchema>;
type SkillResolution = 'selected' | 'no_applicable' | 'unresolved';
type Unresolved = {
  role: 'target' | 'required';
  kind: 'knowledge' | 'skill';
  part_index: number | null;
  reason:
    | 'no_registry_match'
    | 'registry_empty'
    | 'subject_unmapped'
    | 'insufficient_problem_context'
    | 'invalid_model_output';
};

export interface ProblemMarkAnnotationResult {
  status: 'resolved' | 'unresolved' | 'failed' | 'skipped';
  assignments: number;
  unresolved: number;
  error_code?: string;
}

export async function annotateProblemMarks(
  supabase: SupabaseClient<Database>,
  problemId: string,
  options: { aiClient?: AIClient; lock?: KnowledgeRegistryLock } = {}
): Promise<ProblemMarkAnnotationResult> {
  const claim = await claimProblemMarkAnnotation(supabase, problemId);
  if (!claim) {
    return { status: 'skipped', assignments: 0, unresolved: 0 };
  }

  const rawContext = await prepareProblemMarkAnnotation(supabase, claim);
  const envelope = runEnvelopeSchema.parse(rawContext);
  let context: Context;
  try {
    context = preparedContextSchema.parse(rawContext);
  } catch (error) {
    await failProblemMarkAnnotationRun(
      supabase,
      envelope.run_id,
      envelope.lease_token,
      'INVALID_ANNOTATION_CONTEXT'
    );
    throw error;
  }

  const lock = options.lock ?? (await loadKnowledgeRegistryLock());
  try {
    assertLockedRevision(context, lock);
  } catch (error) {
    return recordFailure(
      supabase,
      claim,
      context.run_id,
      annotationErrorCode(error)
    );
  }

  if (!context.subject_key) {
    return commitResult(
      supabase,
      context,
      [],
      [unresolved('target', 'knowledge', 'subject_unmapped')]
    );
  }
  if (context.candidates.length === 0) {
    return commitResult(
      supabase,
      context,
      [],
      [unresolved('target', 'knowledge', 'registry_empty')]
    );
  }

  let parsed: z.infer<typeof modelResultSchema>;
  try {
    const client = options.aiClient ?? createAIClient(AI_CONSTANTS);
    const response = await client.generateContent({
      model: AI_CONSTANTS.MODELS.PROBLEM_MARKING,
      contents: [
        {
          role: 'user',
          parts: [{ text: annotationPrompt(context) }],
        },
      ],
      config: {
        systemInstruction:
          'Classify objective Problem semantics. Select only supplied stable keys. Never infer a learner weakness and never invent taxonomy.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            assignments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  mark_key: { type: 'string' },
                  role: { type: 'string', enum: ['target', 'required'] },
                  part_index: { type: 'integer', nullable: true },
                },
                required: ['mark_key', 'role', 'part_index'],
              },
            },
            unresolved: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['target', 'required'] },
                  kind: { type: 'string', enum: ['knowledge', 'skill'] },
                  part_index: { type: 'integer', nullable: true },
                  reason: { type: 'string', enum: ['no_registry_match'] },
                },
                required: ['role', 'kind', 'part_index', 'reason'],
              },
            },
          },
          required: ['assignments', 'unresolved'],
        },
        temperature: 0,
        maxTokens: 2048,
      },
    });
    parsed = modelResultSchema.parse(JSON.parse(response.text));
  } catch (error) {
    return recordFailure(
      supabase,
      claim,
      context.run_id,
      annotationErrorCode(error)
    );
  }

  const invalidReason = validateModelResult(
    context,
    parsed.assignments,
    parsed.unresolved
  );
  if (invalidReason) {
    return commitResult(
      supabase,
      context,
      [],
      [unresolved('target', 'knowledge', invalidReason)]
    );
  }
  return commitResult(supabase, context, parsed.assignments, parsed.unresolved);
}

function assertLockedRevision(
  context: Context,
  lock: KnowledgeRegistryLock
): void {
  if (
    context.registry_source_sha !== lock.source_sha ||
    context.registry_content_sha256 !== lock.content_sha256 ||
    context.registry_schema_version !== lock.schema_version ||
    context.registry_revision_id === null
  ) {
    throw new Error('REGISTRY_LOCK_MISMATCH');
  }
}

function unresolved(
  role: 'target' | 'required',
  kind: 'knowledge' | 'skill',
  reason:
    | 'registry_empty'
    | 'subject_unmapped'
    | 'insufficient_problem_context'
    | 'invalid_model_output'
): Unresolved {
  return { role, kind, part_index: null, reason };
}

function validateModelResult(
  context: Context,
  assignments: Assignment[],
  unresolvedItems: Unresolved[]
): 'insufficient_problem_context' | 'invalid_model_output' | null {
  const candidates = new Set(context.candidates.map(mark => mark.stable_key));
  const partIndexes = problemPartIndexes(context.parts);
  const assignmentRoles = new Map<string, Assignment['role']>();

  for (const assignment of assignments) {
    if (
      !candidates.has(assignment.mark_key) ||
      !validPartIndex(assignment.part_index, partIndexes)
    ) {
      return 'invalid_model_output';
    }
    const location = `${assignment.mark_key}\0${String(assignment.part_index)}`;
    const priorRole = assignmentRoles.get(location);
    if (priorRole && priorRole !== assignment.role) {
      return 'invalid_model_output';
    }
    assignmentRoles.set(location, assignment.role);
  }

  if (
    unresolvedItems.some(item => !validPartIndex(item.part_index, partIndexes))
  ) {
    return 'invalid_model_output';
  }
  if (assignments.length === 0 && unresolvedItems.length === 0) {
    return 'insufficient_problem_context';
  }
  return null;
}

function problemPartIndexes(parts: unknown): Set<number> {
  return new Set(
    Array.isArray(parts)
      ? parts.flatMap(part =>
          part &&
          typeof part === 'object' &&
          'index' in part &&
          Number.isInteger(Number(part.index))
            ? [Number(part.index)]
            : []
        )
      : []
  );
}

function validPartIndex(
  partIndex: number | null,
  partIndexes: Set<number>
): boolean {
  return partIndex === null || partIndexes.has(partIndex);
}

async function commitResult(
  supabase: SupabaseClient<Database>,
  context: Context,
  assignments: Assignment[],
  unresolvedItems: Unresolved[]
): Promise<ProblemMarkAnnotationResult> {
  const skillCandidateKeys = context.candidates
    .filter(candidate => candidate.kind === 'skill')
    .map(candidate => candidate.stable_key);
  const skillResolution = deriveSkillResolution(
    context,
    assignments,
    unresolvedItems
  );
  const objectiveSnapshot = {
    title: context.title,
    content: context.content,
    parts: context.parts,
    solution_text: context.solution_text,
    assets: context.assets,
    solution_assets: context.solution_assets,
  };
  const skillQuery = {
    title: context.title,
    content: context.content,
    parts: context.parts,
    assets: context.assets,
  };

  const data = await commitProblemMarkAnnotationRun(supabase, {
    runId: context.run_id,
    leaseToken: context.lease_token,
    objectiveSnapshotHash: hashJson(objectiveSnapshot),
    queryHash: hashJson(skillQuery),
    embeddingProfileId: COMPATIBILITY_EMBEDDING_PROFILE,
    queryTemplateVersion: SKILL_QUERY_TEMPLATE_VERSION,
    retrieverVersion: COMPATIBILITY_RETRIEVER_VERSION,
    markingModel: AI_CONSTANTS.MODELS.PROBLEM_MARKING,
    markingPromptVersion: MARKING_PROMPT_VERSION,
    skillResolution,
    skillCandidateKeys,
    assignments,
    unresolved: unresolvedItems,
    retrievalDebug: { skill: [] },
  });
  const result = data as Record<string, unknown>;
  return {
    status: result.status === 'unresolved' ? 'unresolved' : 'resolved',
    assignments: Number(result.assignments),
    unresolved: Number(result.unresolved),
  };
}

function deriveSkillResolution(
  context: Context,
  assignments: Assignment[],
  unresolvedItems: Unresolved[]
): SkillResolution {
  if (unresolvedItems.some(item => item.kind === 'skill')) return 'unresolved';
  const kinds = new Map(
    context.candidates.map(candidate => [candidate.stable_key, candidate.kind])
  );
  return assignments.some(
    assignment => kinds.get(assignment.mark_key) === 'skill'
  )
    ? 'selected'
    : 'no_applicable';
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function annotationPrompt(context: Context): string {
  return JSON.stringify({
    task: 'Choose objective target and required Marks for this Problem.',
    problem: {
      title: context.title,
      content: context.content,
      parts: context.parts,
      solution_text: context.solution_text,
    },
    candidates: context.candidates,
    rules: [
      'Use only candidate stable_key values.',
      'target means directly assessed; required means prerequisite knowledge or skill.',
      'Use part_index null for the shell or a real Problem Part index.',
      'If no candidate matches a location/category, emit no_registry_match.',
    ],
  });
}

async function recordFailure(
  supabase: SupabaseClient<Database>,
  claim: ProblemMarkAnnotationClaim,
  runId: string,
  code: string
): Promise<ProblemMarkAnnotationResult> {
  await failProblemMarkAnnotationRun(supabase, runId, claim.lease_token, code);
  return {
    status: 'failed',
    assignments: 0,
    unresolved: 0,
    error_code: code,
  };
}

function annotationErrorCode(error: unknown): string {
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return 'INVALID_MODEL_OUTPUT';
  }
  return error instanceof Error && error.message === 'REGISTRY_LOCK_MISMATCH'
    ? 'REGISTRY_LOCK_MISMATCH'
    : 'PROBLEM_MARK_PROVIDER_ERROR';
}

async function loadKnowledgeRegistryLock(): Promise<KnowledgeRegistryLock> {
  const lockPath = fileURLToPath(
    new URL('../../knowledge-registry.lock.json', import.meta.url)
  );
  return KnowledgeRegistryLockSchema.parse(
    JSON.parse(await readFile(lockPath, 'utf8'))
  );
}

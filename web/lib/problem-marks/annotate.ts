import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { AI_CONSTANTS } from '@/lib/constants';
import type { Database, Json } from '@/lib/database.types';
import { createAIClient, type AIClient } from '@/lib/ai/client';
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

const candidateSchema = z.object({
  stable_key: z.string(),
  name: z.string(),
  kind: z.enum(['knowledge', 'skill']),
  subject: z.string(),
  aliases: z.array(z.string()),
  description: z.string().nullable(),
  parent: z.string().nullable(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
});
const contextSchema = z
  .object({
    problem_id: z.string().uuid(),
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

type Context = z.infer<typeof contextSchema>;
type Assignment = z.infer<typeof assignmentSchema>;
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
  const { data, error } = await supabase.rpc(
    'get_problem_mark_annotation_context',
    { p_problem_id: problemId }
  );
  if (error)
    throw new Error(`Unable to load Problem Mark context: ${error.message}`);
  const context = contextSchema.parse(data);
  if (!['pending', 'failed'].includes(context.annotation_status)) {
    return { status: 'skipped', assignments: 0, unresolved: 0 };
  }

  const lock = options.lock ?? (await loadKnowledgeRegistryLock());
  assertLockedRevision(context, lock);

  if (!context.subject_key) {
    return applyResult(
      supabase,
      context,
      [],
      [unresolved('target', 'knowledge', 'subject_unmapped')]
    );
  }
  if (context.candidates.length === 0) {
    return applyResult(
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
    return recordFailure(supabase, context, annotationErrorCode(error));
  }

  const invalidReason = validateModelResult(
    context,
    parsed.assignments,
    parsed.unresolved
  );
  if (invalidReason) {
    return applyResult(
      supabase,
      context,
      [],
      [unresolved('target', 'knowledge', invalidReason)]
    );
  }
  return applyResult(supabase, context, parsed.assignments, parsed.unresolved);
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

async function applyResult(
  supabase: SupabaseClient<Database>,
  context: Context,
  assignments: Assignment[],
  unresolvedItems: Unresolved[]
): Promise<ProblemMarkAnnotationResult> {
  const { data, error } = await supabase.rpc('apply_problem_mark_annotation', {
    p_problem_id: context.problem_id,
    p_semantic_revision: context.semantic_revision,
    p_registry_revision_id: context.registry_revision_id!,
    p_assignments: assignments as unknown as Json,
    p_unresolved: unresolvedItems as unknown as Json,
  });
  if (error) throw new Error(`Unable to apply Problem Marks: ${error.message}`);
  const result = data as unknown as Record<string, unknown>;
  return {
    status: result.status === 'unresolved' ? 'unresolved' : 'resolved',
    assignments: Number(result.assignments),
    unresolved: Number(result.unresolved),
  };
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
  context: Context,
  code: string
): Promise<ProblemMarkAnnotationResult> {
  const failure = await supabase.rpc('fail_problem_mark_annotation', {
    p_problem_id: context.problem_id,
    p_semantic_revision: context.semantic_revision,
    p_error_code: code,
  });
  if (failure.error) {
    throw new Error(
      `Unable to record Problem Mark failure: ${failure.error.message}`
    );
  }
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

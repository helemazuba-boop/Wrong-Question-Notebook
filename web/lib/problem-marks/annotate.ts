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
  ProblemMarkLeaseStaleError,
  renewProblemMarkAnnotationLease,
  type ProblemMarkAnnotationClaim,
} from '@/lib/problem-marks/lifecycle';
import {
  KnowledgeRegistryLockSchema,
  type KnowledgeRegistryLock,
} from '@/lib/problem-marks/registry-artifact';
import {
  EmbeddingProviderContractError,
  EmbeddingProviderTransientError,
} from '@/lib/problem-marks/retrieval/embedding-provider';
import {
  buildSkillRetrievalQuery,
  SKILL_QUERY_TEMPLATE_VERSION,
  type SkillRetrievalQueryText,
} from '@/lib/problem-marks/retrieval/skill-query';
import {
  retrieveSkillCandidates,
  SkillRetrievalError,
  type QueryCacheEntry,
  type SkillRetrievalCandidate,
  type SkillRetrievalResult,
  type SkillRetrievalRuntime,
} from '@/lib/problem-marks/retrieval/skill-retriever';
import { loadSkillRetrievalRuntime } from '@/lib/problem-marks/retrieval/skill-runtime';

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

const RETRIEVER_VERSION = 'skill-retriever-v1';
const MARKING_PROMPT_VERSION = 'objective-problem-marking-v1';
const EMPTY_QUERY_HASH = createHash('sha256').update('', 'utf8').digest('hex');

type Context = z.infer<typeof preparedContextSchema>;
type Candidate = z.infer<typeof candidateSchema>;
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

// Retriever seam: the marking authority (the model) only ever sees candidate
// Marks, never retrieval scores. The injected/default retriever supplies the
// Subject-scoped Top10 Skill candidates for one statement-only query.
export type SkillCandidatesRetriever = (
  subject: string,
  query: SkillRetrievalQueryText
) => Promise<SkillRetrievalResult>;

interface SkillRetrievalOutcome {
  candidateKeys: string[];
  candidateViews: Candidate[];
  queryHash: string;
  embeddingProfileId: string;
  queryTemplateVersion: string;
  coverageMiss: boolean;
  debug: Record<string, unknown>;
}

let sharedSkillRuntime: Promise<SkillRetrievalRuntime> | null = null;
const sharedSkillQueryCache = new Map<string, QueryCacheEntry>();

function defaultSkillRetriever(
  lock: KnowledgeRegistryLock
): SkillCandidatesRetriever {
  return (subject, query) => {
    // Artifact/manifest/profile/credential load failures are terminal for this
    // run, not a hot-loop: surface them as a controlled contract failure (which
    // records backoff) and clear the shared slot so a later call can retry once
    // the underlying issue is fixed.
    sharedSkillRuntime ??= loadSkillRetrievalRuntime(lock).catch(error => {
      sharedSkillRuntime = null;
      throw error instanceof SkillRetrievalError
        ? error
        : new SkillRetrievalError(
            'SKILL_RETRIEVAL_CONTRACT',
            'Unable to load the locked Skill retrieval runtime'
          );
    });
    return sharedSkillRuntime.then(runtime =>
      retrieveSkillCandidates(runtime, subject, query, sharedSkillQueryCache)
    );
  };
}

export interface AnnotateProblemMarkOptions {
  aiClient?: AIClient;
  lock?: KnowledgeRegistryLock;
  skillRetrieve?: SkillCandidatesRetriever;
  leaseSeconds?: number;
}

// Single-problem entry (the internal HMAC route): claim one Problem, then run
// the shared per-claim pipeline. Returns 'skipped' when another worker holds
// or has already finished the annotation.
export async function annotateProblemMarks(
  supabase: SupabaseClient<Database>,
  problemId: string,
  options: AnnotateProblemMarkOptions = {}
): Promise<ProblemMarkAnnotationResult> {
  const claim = await claimProblemMarkAnnotation(
    supabase,
    problemId,
    options.leaseSeconds ?? 120
  );
  if (!claim) {
    return { status: 'skipped', assignments: 0, unresolved: 0 };
  }
  return annotateClaimedProblemMark(supabase, claim, options);
}

// Shared per-claim pipeline used by both the single-problem route and the
// bounded batch worker. The lease token lives in a mutable cell because the
// generation-tagged renewal RPC rotates it; every commit/fail must present the
// latest token or the DB rejects it as stale.
export async function annotateClaimedProblemMark(
  supabase: SupabaseClient<Database>,
  claim: ProblemMarkAnnotationClaim,
  options: AnnotateProblemMarkOptions = {}
): Promise<ProblemMarkAnnotationResult> {
  const leaseSeconds = options.leaseSeconds ?? 120;
  const lease = { token: claim.lease_token };

  const rawContext = await prepareProblemMarkAnnotation(supabase, claim);
  const envelope = runEnvelopeSchema.parse(rawContext);
  let context: Context;
  try {
    context = preparedContextSchema.parse(rawContext);
  } catch (error) {
    await failProblemMarkAnnotationRun(
      supabase,
      envelope.run_id,
      lease.token,
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
      context.run_id,
      lease.token,
      annotationErrorCode(error)
    );
  }

  const retrieve = options.skillRetrieve ?? defaultSkillRetriever(lock);

  if (!context.subject_key) {
    return commitResult(
      supabase,
      context,
      lease,
      [],
      [unresolved('target', 'knowledge', 'subject_unmapped')],
      skippedRetrieval(lock, 'subject_unmapped')
    );
  }
  const subjectKey = context.subject_key;
  if (context.candidates.length === 0) {
    return commitResult(
      supabase,
      context,
      lease,
      [],
      [unresolved('target', 'knowledge', 'registry_empty')],
      skippedRetrieval(lock, 'registry_empty')
    );
  }

  const retrieval = await resolveSkillRetrieval({
    supabase,
    lock,
    context,
    retrieve,
    subjectKey,
    lease,
  });
  if ('failure' in retrieval) {
    return retrieval.failure;
  }
  const skill = retrieval.outcome;

  // Renew between the two slow external calls (embedding, then marking). If the
  // lease was lost — expired and reclaimed, or finished elsewhere — the token
  // has rotated away, so stop immediately; a commit would be rejected as stale.
  if (!(await renewLease(supabase, context, lease, leaseSeconds))) {
    return skippedResult();
  }

  const knowledgeCandidates = context.candidates.filter(
    candidate => candidate.kind === 'knowledge'
  );
  const promptCandidates = [...knowledgeCandidates, ...skill.candidateViews];

  let parsed: z.infer<typeof modelResultSchema>;
  try {
    const client = options.aiClient ?? createAIClient(AI_CONSTANTS);
    const response = await client.generateContent({
      model: AI_CONSTANTS.MODELS.PROBLEM_MARKING,
      contents: [
        {
          role: 'user',
          parts: [{ text: annotationPrompt(context, promptCandidates) }],
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
      context.run_id,
      lease.token,
      annotationErrorCode(error)
    );
  }

  // Renew again after marking so the CAS commit presents a live token.
  if (!(await renewLease(supabase, context, lease, leaseSeconds))) {
    return skippedResult();
  }

  const allowedKeys = new Set([
    ...knowledgeCandidates.map(candidate => candidate.stable_key),
    ...skill.candidateKeys,
  ]);
  const invalidReason = validateModelResult(
    context,
    allowedKeys,
    parsed.assignments,
    parsed.unresolved
  );
  if (invalidReason) {
    return commitResult(
      supabase,
      context,
      lease,
      [],
      [unresolved('target', 'knowledge', invalidReason)],
      skill
    );
  }

  // A retrieval coverage miss means Skill applicability cannot be determined;
  // Knowledge is still marked, but the run must surface an unresolved Skill so
  // skill_resolution stays honest (distinct from a genuine no_applicable).
  const unresolvedItems = [...parsed.unresolved];
  if (
    skill.coverageMiss &&
    !unresolvedItems.some(item => item.kind === 'skill')
  ) {
    unresolvedItems.push({
      role: 'target',
      kind: 'skill',
      part_index: null,
      reason: 'no_registry_match',
    });
  }
  return commitResult(
    supabase,
    context,
    lease,
    parsed.assignments,
    unresolvedItems,
    skill
  );
}

interface ResolveSkillRetrievalEnv {
  supabase: SupabaseClient<Database>;
  lock: KnowledgeRegistryLock;
  context: Context;
  retrieve: SkillCandidatesRetriever;
  subjectKey: string;
  lease: { token: string };
}

async function resolveSkillRetrieval(
  env: ResolveSkillRetrievalEnv
): Promise<
  { outcome: SkillRetrievalOutcome } | { failure: ProblemMarkAnnotationResult }
> {
  const { supabase, lock, context, retrieve, subjectKey, lease } = env;
  let query: SkillRetrievalQueryText;
  try {
    query = buildSkillRetrievalQuery({
      title: context.title,
      content: context.content,
      parts: context.parts,
    });
  } catch {
    return {
      failure: await recordFailure(
        supabase,
        context.run_id,
        lease.token,
        'SKILL_QUERY_INVALID'
      ),
    };
  }
  const queryHash = hashText(query.text);

  let result: SkillRetrievalResult;
  try {
    result = await retrieve(subjectKey, query);
  } catch (error) {
    const mapping = mapRetrievalError(error);
    if (mapping === 'unknown') throw error;
    if (mapping === 'coverage') {
      return {
        outcome: {
          candidateKeys: [],
          candidateViews: [],
          queryHash,
          embeddingProfileId: lock.skill_retrieval.profile_id,
          queryTemplateVersion: query.templateVersion,
          coverageMiss: true,
          debug: {
            skill: [],
            coverage: 'miss',
            subject: subjectKey,
            profile_fingerprint: lock.skill_retrieval.profile_fingerprint,
            representation_revision:
              lock.skill_retrieval.representation_revision,
          },
        },
      };
    }
    return {
      failure: await recordFailure(
        supabase,
        context.run_id,
        lease.token,
        mapping === 'transient'
          ? 'SKILL_RETRIEVAL_TRANSIENT'
          : 'SKILL_RETRIEVAL_CONTRACT'
      ),
    };
  }

  return {
    outcome: {
      candidateKeys: result.candidates.map(candidate => candidate.stable_key),
      candidateViews: skillCandidateViews(context, result.candidates),
      queryHash,
      embeddingProfileId: result.profileId,
      queryTemplateVersion: result.queryTemplateVersion,
      coverageMiss: false,
      debug: {
        skill: result.candidates.map(candidate => ({
          stable_key: candidate.stable_key,
          rank: candidate.rank,
          score: candidate.score,
        })),
        coverage: 'hit',
        profile_fingerprint: result.profileFingerprint,
        representation_revision: result.representationRevision,
        ...result.retrievalDebug,
      },
    },
  };
}

function mapRetrievalError(
  error: unknown
): 'coverage' | 'transient' | 'contract' | 'unknown' {
  if (error instanceof SkillRetrievalError) {
    if (error.code === 'SKILL_RETRIEVAL_COVERAGE_MISS') return 'coverage';
    if (error.code === 'SKILL_RETRIEVAL_PROVIDER_TRANSIENT') return 'transient';
    return 'contract';
  }
  if (error instanceof EmbeddingProviderTransientError) return 'transient';
  if (error instanceof EmbeddingProviderContractError) return 'contract';
  return 'unknown';
}

function skillCandidateViews(
  context: Context,
  candidates: SkillRetrievalCandidate[]
): Candidate[] {
  const byKey = new Map(
    context.candidates.map(candidate => [candidate.stable_key, candidate])
  );
  return candidates.map(
    candidate =>
      byKey.get(candidate.stable_key) ?? {
        stable_key: candidate.stable_key,
        name: candidate.title,
        kind: 'skill',
        subject: context.subject_key ?? '',
        aliases: [],
        description: null,
        parent: null,
        include: [],
        exclude: [],
      }
  );
}

function skippedRetrieval(
  lock: KnowledgeRegistryLock,
  reason: 'subject_unmapped' | 'registry_empty'
): SkillRetrievalOutcome {
  return {
    candidateKeys: [],
    candidateViews: [],
    queryHash: EMPTY_QUERY_HASH,
    embeddingProfileId: lock.skill_retrieval.profile_id,
    queryTemplateVersion: SKILL_QUERY_TEMPLATE_VERSION,
    coverageMiss: false,
    debug: { skill: [], coverage: 'skipped', reason },
  };
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
  allowedKeys: Set<string>,
  assignments: Assignment[],
  unresolvedItems: Unresolved[]
): 'insufficient_problem_context' | 'invalid_model_output' | null {
  const partIndexes = problemPartIndexes(context.parts);
  const assignmentRoles = new Map<string, Assignment['role']>();

  for (const assignment of assignments) {
    if (
      !allowedKeys.has(assignment.mark_key) ||
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
  lease: { token: string },
  assignments: Assignment[],
  unresolvedItems: Unresolved[],
  skill: SkillRetrievalOutcome
): Promise<ProblemMarkAnnotationResult> {
  const skillResolution = deriveSkillResolution(
    assignments,
    unresolvedItems,
    skill.candidateKeys,
    skill.coverageMiss
  );
  const objectiveSnapshot = {
    title: context.title,
    content: context.content,
    parts: context.parts,
    solution_text: context.solution_text,
    assets: context.assets,
    solution_assets: context.solution_assets,
  };

  const data = await commitProblemMarkAnnotationRun(supabase, {
    runId: context.run_id,
    leaseToken: lease.token,
    objectiveSnapshotHash: hashJson(objectiveSnapshot),
    queryHash: skill.queryHash,
    embeddingProfileId: skill.embeddingProfileId,
    queryTemplateVersion: skill.queryTemplateVersion,
    retrieverVersion: RETRIEVER_VERSION,
    markingModel: AI_CONSTANTS.MODELS.PROBLEM_MARKING,
    markingPromptVersion: MARKING_PROMPT_VERSION,
    skillResolution,
    skillCandidateKeys: skill.candidateKeys,
    assignments,
    unresolved: unresolvedItems,
    retrievalDebug: skill.debug,
  });
  const result = data as Record<string, unknown>;
  return {
    status: result.status === 'unresolved' ? 'unresolved' : 'resolved',
    assignments: Number(result.assignments),
    unresolved: Number(result.unresolved),
  };
}

function deriveSkillResolution(
  assignments: Assignment[],
  unresolvedItems: Unresolved[],
  skillCandidateKeys: string[],
  coverageMiss: boolean
): SkillResolution {
  if (coverageMiss || unresolvedItems.some(item => item.kind === 'skill')) {
    return 'unresolved';
  }
  const skillKeys = new Set(skillCandidateKeys);
  return assignments.some(assignment => skillKeys.has(assignment.mark_key))
    ? 'selected'
    : 'no_applicable';
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function annotationPrompt(context: Context, candidates: Candidate[]): string {
  return JSON.stringify({
    task: 'Choose objective target and required Marks for this Problem.',
    problem: {
      title: context.title,
      content: context.content,
      parts: context.parts,
      solution_text: context.solution_text,
    },
    candidates,
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
  runId: string,
  leaseToken: string,
  code: string
): Promise<ProblemMarkAnnotationResult> {
  await failProblemMarkAnnotationRun(supabase, runId, leaseToken, code);
  return {
    status: 'failed',
    assignments: 0,
    unresolved: 0,
    error_code: code,
  };
}

function skippedResult(): ProblemMarkAnnotationResult {
  return { status: 'skipped', assignments: 0, unresolved: 0 };
}

// Renew the lease between long external steps. Returns false when the lease was
// lost (expired and reclaimed, or finished elsewhere) — the generation-tagged
// RPC has rotated the token, so this worker must stop without committing.
async function renewLease(
  supabase: SupabaseClient<Database>,
  context: Context,
  lease: { token: string },
  leaseSeconds: number
): Promise<boolean> {
  try {
    const renewed = await renewProblemMarkAnnotationLease(
      supabase,
      context.problem_id,
      lease.token,
      leaseSeconds
    );
    lease.token = renewed.leaseToken;
    return true;
  } catch (error) {
    if (error instanceof ProblemMarkLeaseStaleError) return false;
    throw error;
  }
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

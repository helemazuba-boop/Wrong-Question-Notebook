import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AIClient } from '@/lib/ai/client';
import type { SkillCandidatesRetriever } from '@/lib/problem-marks/annotate';
import type { KnowledgeRegistryLock } from '@/lib/problem-marks/registry-artifact';
import type { SkillRetrievalQueryText } from '@/lib/problem-marks/retrieval/skill-query';
import { runProblemMarkAnnotationBatch } from '@/lib/problem-marks/worker';

const SOURCE_SHA = 'a'.repeat(40);
const CONTENT_SHA = 'b'.repeat(64);
const RENEWED_TOKEN = '44444444-4444-4444-8444-444444444444';
const lock: KnowledgeRegistryLock = {
  repository: 'https://github.com/example/registry',
  source_sha: SOURCE_SHA,
  schema_version: 1,
  artifact_url: `https://raw.githubusercontent.com/example/registry/${SOURCE_SHA}/dist/registry.json`,
  content_sha256: CONTENT_SHA,
  skill_retrieval: {
    profile_id: 'skill-rag-qwen37-v1',
    profile_fingerprint: `sha256:${'1'.repeat(64)}`,
    provider_protocol: 'dashscope-qwen37-native-v1',
    representation_revision: `sha256:${'2'.repeat(64)}`,
    artifact_url: `https://raw.githubusercontent.com/example/registry/${SOURCE_SHA}/dist/skill-retrieval/skill-rag-qwen37-v1.json`,
    artifact_sha256: '3'.repeat(64),
    manifest_url: `https://raw.githubusercontent.com/example/registry/${SOURCE_SHA}/dist/skill-retrieval/skill-rag-qwen37-v1.manifest.json`,
    manifest_sha256: '4'.repeat(64),
  },
};

const pid = (index: number) =>
  `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const token = (index: number) =>
  `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const runId = (index: number) =>
  `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

interface FakeProblem {
  id: string;
  title: string;
}

function contextFor(problem: FakeProblem, index: number) {
  return {
    run_id: runId(index),
    lease_token: token(index),
    problem_id: problem.id,
    semantic_revision: 2,
    annotation_status: 'pending',
    title: problem.title,
    content: 'Solve for x.',
    parts: [{ index: 1, content: 'Part one' }],
    solution_text: 'Separate the parameter.',
    assets: [],
    solution_assets: [],
    subject_key: 'math',
    registry_revision_id: 9,
    registry_source_sha: SOURCE_SHA,
    registry_content_sha256: CONTENT_SHA,
    registry_schema_version: 1,
    candidates: [
      {
        stable_key: 'math.knowledge.function',
        name: 'math.knowledge.function',
        kind: 'knowledge',
        subject: 'math',
        aliases: [],
        description: null,
        parent: null,
        include: [],
        exclude: [],
      },
    ],
  };
}

function makeBatchSupabase(problems: FakeProblem[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const claims = problems.map((problem, index) => ({
    problem_id: problem.id,
    semantic_revision: 2,
    lease_token: token(index),
    lease_until: '2026-08-11T01:02:03.000Z',
    attempt_count: 1,
  }));
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'claim_problem_mark_annotations') {
      return { data: claims, error: null };
    }
    if (name === 'prepare_problem_mark_annotation') {
      const index = problems.findIndex(
        problem => problem.id === args.p_problem_id
      );
      return { data: contextFor(problems[index], index), error: null };
    }
    if (name === 'renew_problem_mark_annotation_lease') {
      return {
        data: {
          lease_token: RENEWED_TOKEN,
          lease_until: '2026-08-11T01:04:03.000Z',
        },
        error: null,
      };
    }
    if (name === 'commit_problem_mark_annotation_run') {
      const assignments = args.p_assignments as unknown[];
      const unresolved = args.p_unresolved as unknown[];
      return {
        data: {
          status: unresolved.length > 0 ? 'unresolved' : 'resolved',
          assignments: assignments.length,
          unresolved: unresolved.length,
        },
        error: null,
      };
    }
    if (name === 'fail_problem_mark_annotation_run') {
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
  return { supabase: { rpc } as never, rpc, calls };
}

// Marking fails for any Problem whose title asks for it, so one claim can be
// forced to fail while the rest of the batch succeeds.
function aiForBatch(): AIClient {
  return {
    generateContent: vi.fn(async (request: any) => {
      const text = request.contents[0].parts[0].text as string;
      if (text.includes('MARKING_FAILS')) throw new Error('marking boom');
      return {
        text: JSON.stringify({
          assignments: [
            {
              mark_key: 'math.knowledge.function',
              role: 'target',
              part_index: 1,
            },
          ],
          unresolved: [],
        }),
      };
    }),
  };
}

function fakeRetrieve(): SkillCandidatesRetriever {
  return async (subject: string, query: SkillRetrievalQueryText) => ({
    profileId: lock.skill_retrieval.profile_id,
    profileFingerprint: lock.skill_retrieval.profile_fingerprint,
    representationRevision: lock.skill_retrieval.representation_revision,
    queryTemplateVersion: query.templateVersion,
    queryHash: createHash('sha256').update(query.text, 'utf8').digest('hex'),
    candidates: [
      {
        stable_key: 'math.skill.parameter_separation',
        title: 'p',
        score: 0.9,
        rank: 1,
      },
    ],
    retrievalDebug: { top_k: 10, subject, candidate_count: 1 },
  });
}

const problems = (count: number): FakeProblem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: pid(index),
    title: `Problem ${index}`,
  }));

describe('Problem Mark batch worker', () => {
  it('claims a batch and resolves every claim through the shared pipeline', async () => {
    const db = makeBatchSupabase(problems(3));
    const result = await runProblemMarkAnnotationBatch({
      supabase: db.supabase,
      limit: 10,
      concurrency: 2,
      leaseSeconds: 180,
      aiClient: aiForBatch(),
      lock,
      skillRetrieve: fakeRetrieve(),
    });

    expect(result).toEqual({
      claimed: 3,
      resolved: 3,
      unresolved: 0,
      failed: 0,
      skipped: 0,
      stoppedEarly: false,
    });
    const claimCall = db.calls.find(
      call => call.name === 'claim_problem_mark_annotations'
    );
    expect(claimCall?.args).toEqual({ p_limit: 10, p_lease_seconds: 180 });
    // Each claimed Problem reaches its own commit.
    const commits = db.calls.filter(
      call => call.name === 'commit_problem_mark_annotation_run'
    );
    expect(commits).toHaveLength(3);
    expect(new Set(commits.map(call => call.args.p_run_id)).size).toBe(3);
  });

  it('isolates a per-claim failure without aborting the batch', async () => {
    const batch = problems(3);
    batch[1].title = 'MARKING_FAILS problem';
    const db = makeBatchSupabase(batch);

    const result = await runProblemMarkAnnotationBatch({
      supabase: db.supabase,
      limit: 10,
      concurrency: 2,
      aiClient: aiForBatch(),
      lock,
      skillRetrieve: fakeRetrieve(),
    });

    expect(result).toMatchObject({
      claimed: 3,
      resolved: 2,
      failed: 1,
      stoppedEarly: false,
    });
    const fails = db.calls.filter(
      call => call.name === 'fail_problem_mark_annotation_run'
    );
    expect(fails).toHaveLength(1);
    expect(fails[0].args.p_error_code).toBe('PROBLEM_MARK_PROVIDER_ERROR');
  });

  it('caps the claim limit at the RPC maximum', async () => {
    const db = makeBatchSupabase(problems(2));
    await runProblemMarkAnnotationBatch({
      supabase: db.supabase,
      limit: 100,
      aiClient: aiForBatch(),
      lock,
      skillRetrieve: fakeRetrieve(),
    });
    const claimCall = db.calls.find(
      call => call.name === 'claim_problem_mark_annotations'
    );
    expect(claimCall?.args.p_limit).toBe(50);
  });

  it('stops early when the batch budget is already exhausted', async () => {
    const db = makeBatchSupabase(problems(3));
    const result = await runProblemMarkAnnotationBatch({
      supabase: db.supabase,
      limit: 10,
      concurrency: 1,
      deadlineMs: -1,
      aiClient: aiForBatch(),
      lock,
      skillRetrieve: fakeRetrieve(),
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.claimed).toBe(3);
    expect(result.resolved).toBe(0);
    expect(
      db.calls.some(call => call.name === 'commit_problem_mark_annotation_run')
    ).toBe(false);
  });
});

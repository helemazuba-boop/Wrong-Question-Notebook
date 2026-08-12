import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIClient } from '@/lib/ai/client';
import { annotateProblemMarks } from '@/lib/problem-marks/annotate';
import type { KnowledgeRegistryLock } from '@/lib/problem-marks/registry-artifact';

const PROBLEM_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const LEASE_TOKEN = '33333333-3333-4333-8333-333333333333';
const SOURCE_SHA = 'a'.repeat(40);
const CONTENT_SHA = 'b'.repeat(64);
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

function candidate(
  stableKey: string,
  kind: 'knowledge' | 'skill' = 'knowledge'
) {
  return {
    stable_key: stableKey,
    name: stableKey,
    kind,
    subject: 'math',
    aliases: [],
    description: null,
    parent: null,
    include: [],
    exclude: [],
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    lease_token: LEASE_TOKEN,
    problem_id: PROBLEM_ID,
    semantic_revision: 2,
    annotation_status: 'pending',
    title: 'Parameter problem',
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
      candidate('math.knowledge.function'),
      candidate('math.skill.parameter_separation', 'skill'),
    ],
    ...overrides,
  };
}

function makeSupabase(contextValue = context()) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'claim_problem_mark_annotation') {
      return {
        data: {
          problem_id: PROBLEM_ID,
          semantic_revision: 2,
          lease_token: LEASE_TOKEN,
          lease_until: '2026-08-11T01:02:03.000Z',
          attempt_count: 1,
        },
        error: null,
      };
    }
    if (name === 'prepare_problem_mark_annotation') {
      return { data: contextValue, error: null };
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

function aiResult(value: unknown): AIClient {
  return {
    generateContent: vi.fn().mockResolvedValue({ text: JSON.stringify(value) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Problem Mark annotator', () => {
  it('claims a lease and commits only candidates returned for the current Subject', async () => {
    const db = makeSupabase();
    const ai = aiResult({
      assignments: [
        {
          mark_key: 'math.skill.parameter_separation',
          role: 'target',
          part_index: 1,
        },
      ],
      unresolved: [],
    });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
    ).resolves.toEqual({ status: 'resolved', assignments: 1, unresolved: 0 });

    expect(db.calls.map(call => call.name)).toEqual([
      'claim_problem_mark_annotation',
      'prepare_problem_mark_annotation',
      'commit_problem_mark_annotation_run',
    ]);
    const prompt = vi.mocked(ai.generateContent).mock.calls[0][0].contents[0]
      .parts[0].text;
    expect(prompt).toContain('math.skill.parameter_separation');
    expect(prompt).toContain('math.knowledge.function');
    expect(prompt).not.toContain('physics.knowledge.motion');
    const commit = db.calls.at(-1)?.args;
    expect(commit?.p_skill_candidate_keys).toEqual([
      'math.skill.parameter_separation',
    ]);
    expect(commit?.p_skill_resolution).toBe('selected');
    expect(commit?.p_assignments).toEqual([
      {
        mark_key: 'math.skill.parameter_separation',
        role: 'target',
        part_index: 1,
      },
    ]);
  });

  it('skips when another worker owns or completed the annotation', async () => {
    const db = makeSupabase();
    db.rpc.mockResolvedValueOnce({ data: null, error: null });
    const ai = aiResult({ assignments: [], unresolved: [] });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
    ).resolves.toEqual({
      status: 'skipped',
      assignments: 0,
      unresolved: 0,
    });
    expect(ai.generateContent).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('claim_problem_mark_annotation', {
      p_problem_id: PROBLEM_ID,
      p_lease_seconds: 120,
    });
  });

  it.each([
    ['unmapped Subject', { subject_key: null }, 'subject_unmapped'],
    ['empty Registry candidates', { candidates: [] }, 'registry_empty'],
  ])(
    'records controlled unresolved for %s without calling AI',
    async (_, patch, reason) => {
      const db = makeSupabase(context(patch));
      const ai = aiResult({ assignments: [], unresolved: [] });

      await expect(
        annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
      ).resolves.toMatchObject({ status: 'unresolved', assignments: 0 });

      expect(ai.generateContent).not.toHaveBeenCalled();
      expect(db.calls.at(-1)?.args.p_unresolved).toEqual([
        {
          role: 'target',
          kind: 'knowledge',
          part_index: null,
          reason,
        },
      ]);
      expect(db.calls.at(-1)?.args.p_skill_resolution).toBe('no_applicable');
    }
  );

  it.each([
    ['unknown key', 'math.knowledge.not_in_registry', 1],
    ['wrong Subject key', 'physics.knowledge.motion', 1],
    ['deprecated/non-candidate key', 'math.knowledge.deprecated', 1],
    ['invalid Part', 'math.knowledge.function', 2],
  ])(
    'turns %s model output into unresolved with zero forged edges',
    async (_, markKey, partIndex) => {
      const db = makeSupabase();
      const ai = aiResult({
        assignments: [
          { mark_key: markKey, role: 'target', part_index: partIndex },
        ],
        unresolved: [],
      });

      await expect(
        annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
      ).resolves.toMatchObject({ status: 'unresolved', assignments: 0 });

      expect(db.calls.at(-1)?.args.p_assignments).toEqual([]);
      expect(db.calls.at(-1)?.args.p_unresolved).toMatchObject([
        { reason: 'invalid_model_output' },
      ]);
    }
  );

  it('fails the claimed run when the DB revision mismatches the lock', async () => {
    const db = makeSupabase(
      context({ registry_content_sha256: 'c'.repeat(64) })
    );
    const ai = aiResult({ assignments: [], unresolved: [] });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
    ).resolves.toEqual({
      status: 'failed',
      assignments: 0,
      unresolved: 0,
      error_code: 'REGISTRY_LOCK_MISMATCH',
    });
    expect(ai.generateContent).not.toHaveBeenCalled();
    expect(db.calls.map(call => call.name)).toEqual([
      'claim_problem_mark_annotation',
      'prepare_problem_mark_annotation',
      'fail_problem_mark_annotation_run',
    ]);
  });

  it('rejects personal idea fields and terminally fails the malformed context run', async () => {
    const db = makeSupabase(
      context({
        initial_idea: 'I guessed from the graph.',
        problem_user_context: { current_initial_idea_revision_id: 'private' },
      })
    );
    const ai = aiResult({ assignments: [], unresolved: [] });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
    ).rejects.toThrow();
    expect(ai.generateContent).not.toHaveBeenCalled();
    expect(db.calls.map(call => call.name)).toEqual([
      'claim_problem_mark_annotation',
      'prepare_problem_mark_annotation',
      'fail_problem_mark_annotation_run',
    ]);
    expect(db.calls.at(-1)?.args.p_error_code).toBe(
      'INVALID_ANNOTATION_CONTEXT'
    );
  });

  it('records provider failures against the claimed run and lease', async () => {
    const db = makeSupabase();
    const ai: AIClient = {
      generateContent: vi
        .fn()
        .mockRejectedValue(new Error('provider unavailable')),
    };

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
    ).resolves.toEqual({
      status: 'failed',
      assignments: 0,
      unresolved: 0,
      error_code: 'PROBLEM_MARK_PROVIDER_ERROR',
    });
    expect(db.calls.at(-1)).toEqual({
      name: 'fail_problem_mark_annotation_run',
      args: {
        p_run_id: RUN_ID,
        p_lease_token: LEASE_TOKEN,
        p_error_code: 'PROBLEM_MARK_PROVIDER_ERROR',
      },
    });
  });
});

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIClient } from '@/lib/ai/client';
import {
  annotateProblemMarks,
  type SkillCandidatesRetriever,
} from '@/lib/problem-marks/annotate';
import type { KnowledgeRegistryLock } from '@/lib/problem-marks/registry-artifact';
import {
  EmbeddingProviderContractError,
  EmbeddingProviderTransientError,
} from '@/lib/problem-marks/retrieval/embedding-provider';
import {
  buildSkillRetrievalQuery,
  type SkillRetrievalQueryText,
} from '@/lib/problem-marks/retrieval/skill-query';
import { SkillRetrievalError } from '@/lib/problem-marks/retrieval/skill-retriever';

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

const PROBLEM_PARTS = [{ index: 1, content: 'Part one' }];

function context(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    lease_token: LEASE_TOKEN,
    problem_id: PROBLEM_ID,
    semantic_revision: 2,
    annotation_status: 'pending',
    title: 'Parameter problem',
    content: 'Solve for x.',
    parts: PROBLEM_PARTS,
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

// A fake Retriever returning a fixed Skill Top10, recording the exact
// statement-only query it was given so tests can assert the security boundary.
function fakeRetrieve(
  skillKeys: string[] = ['math.skill.parameter_separation']
) {
  return vi.fn(async (subject: string, query: SkillRetrievalQueryText) => ({
    profileId: lock.skill_retrieval.profile_id,
    profileFingerprint: lock.skill_retrieval.profile_fingerprint,
    representationRevision: lock.skill_retrieval.representation_revision,
    queryTemplateVersion: query.templateVersion,
    queryHash: createHash('sha256').update(query.text, 'utf8').digest('hex'),
    candidates: skillKeys.map((stable_key, index) => ({
      stable_key,
      title: stable_key,
      score: 1 - index * 0.01,
      rank: index + 1,
    })),
    retrievalDebug: { top_k: 10, subject, candidate_count: skillKeys.length },
  })) satisfies SkillCandidatesRetriever;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Problem Mark annotator', () => {
  it('claims a lease and commits only candidates returned for the current Subject', async () => {
    const db = makeSupabase();
    const retrieve = fakeRetrieve();
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
      annotateProblemMarks(db.supabase, PROBLEM_ID, {
        aiClient: ai,
        lock,
        skillRetrieve: retrieve,
      })
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
    // Retrieval scores/ranks never reach the marking authority.
    expect(prompt).not.toContain('"score"');
    expect(prompt).not.toContain('"rank"');
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

  it('sends only the statement-only query to the Retriever and stamps real provenance', async () => {
    const db = makeSupabase();
    const retrieve = fakeRetrieve();
    const ai = aiResult({ assignments: [], unresolved: [] });

    await annotateProblemMarks(db.supabase, PROBLEM_ID, {
      aiClient: ai,
      lock,
      skillRetrieve: retrieve,
    });

    expect(retrieve).toHaveBeenCalledTimes(1);
    const [subject, query] = retrieve.mock.calls[0];
    expect(subject).toBe('math');
    expect(query.templateVersion).toBe('skill-question-instruction-v1');
    // The Retriever only ever sees the objective statement — never the
    // solution, correct answers, or any personal idea.
    expect(query.text).toContain('Parameter problem');
    expect(query.text).toContain('Part one');
    expect(query.text).not.toContain('Separate the parameter.');

    const expectedQuery = buildSkillRetrievalQuery({
      title: 'Parameter problem',
      content: 'Solve for x.',
      parts: PROBLEM_PARTS,
    });
    const expectedQueryHash = createHash('sha256')
      .update(expectedQuery.text, 'utf8')
      .digest('hex');

    const commit = db.calls.at(-1)?.args;
    expect(commit?.p_query_hash).toBe(expectedQueryHash);
    expect(commit?.p_embedding_profile_id).toBe('skill-rag-qwen37-v1');
    expect(commit?.p_query_template_version).toBe(
      'skill-question-instruction-v1'
    );
    expect(commit?.p_retriever_version).toBe('skill-retriever-v1');
    expect(commit?.p_marking_prompt_version).toBe(
      'objective-problem-marking-v1'
    );
    const debug = commit?.p_retrieval_debug as Record<string, unknown>;
    expect(debug.profile_fingerprint).toBe(
      lock.skill_retrieval.profile_fingerprint
    );
    expect(debug.representation_revision).toBe(
      lock.skill_retrieval.representation_revision
    );
    expect(debug.coverage).toBe('hit');
  });

  it('rejects a Skill the model invented outside the retrieved Top10', async () => {
    const db = makeSupabase();
    const retrieve = fakeRetrieve(['math.skill.parameter_separation']);
    const ai = aiResult({
      assignments: [
        { mark_key: 'math.skill.not_retrieved', role: 'target', part_index: 1 },
      ],
      unresolved: [],
    });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, {
        aiClient: ai,
        lock,
        skillRetrieve: retrieve,
      })
    ).resolves.toMatchObject({ status: 'unresolved', assignments: 0 });

    expect(db.calls.at(-1)?.args.p_assignments).toEqual([]);
    expect(db.calls.at(-1)?.args.p_unresolved).toMatchObject([
      { reason: 'invalid_model_output' },
    ]);
  });

  it('marks Knowledge but surfaces an unresolved Skill on retrieval coverage miss', async () => {
    const db = makeSupabase();
    const retrieve = vi.fn(async () => {
      throw new SkillRetrievalError(
        'SKILL_RETRIEVAL_COVERAGE_MISS',
        'no documents for subject'
      );
    }) satisfies SkillCandidatesRetriever;
    const ai = aiResult({
      assignments: [
        { mark_key: 'math.knowledge.function', role: 'target', part_index: 1 },
      ],
      unresolved: [],
    });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, {
        aiClient: ai,
        lock,
        skillRetrieve: retrieve,
      })
    ).resolves.toMatchObject({ status: 'unresolved', assignments: 1 });

    const commit = db.calls.at(-1)?.args;
    // Knowledge is still marked from the full Subject candidate set...
    expect(commit?.p_assignments).toEqual([
      { mark_key: 'math.knowledge.function', role: 'target', part_index: 1 },
    ]);
    // ...but the Skill side is honestly unresolved, never no_applicable.
    expect(commit?.p_skill_candidate_keys).toEqual([]);
    expect(commit?.p_skill_resolution).toBe('unresolved');
    expect(commit?.p_unresolved).toMatchObject([
      { kind: 'skill', reason: 'no_registry_match' },
    ]);
  });

  it.each([
    [
      'transient provider error',
      () => new EmbeddingProviderTransientError('boom'),
      'SKILL_RETRIEVAL_TRANSIENT',
    ],
    [
      'contract violation',
      () => new EmbeddingProviderContractError('boom'),
      'SKILL_RETRIEVAL_CONTRACT',
    ],
    [
      'retriever contract error',
      () => new SkillRetrievalError('SKILL_RETRIEVAL_CONTRACT', 'boom'),
      'SKILL_RETRIEVAL_CONTRACT',
    ],
  ])(
    'fails the run without calling the model on %s',
    async (_, makeError, code) => {
      const db = makeSupabase();
      const retrieve = vi.fn(async () => {
        throw makeError();
      }) satisfies SkillCandidatesRetriever;
      const ai = aiResult({ assignments: [], unresolved: [] });

      await expect(
        annotateProblemMarks(db.supabase, PROBLEM_ID, {
          aiClient: ai,
          lock,
          skillRetrieve: retrieve,
        })
      ).resolves.toEqual({
        status: 'failed',
        assignments: 0,
        unresolved: 0,
        error_code: code,
      });
      expect(ai.generateContent).not.toHaveBeenCalled();
      expect(db.calls.at(-1)).toEqual({
        name: 'fail_problem_mark_annotation_run',
        args: {
          p_run_id: RUN_ID,
          p_lease_token: LEASE_TOKEN,
          p_error_code: code,
        },
      });
    }
  );

  it('skips when another worker owns or completed the annotation', async () => {
    const db = makeSupabase();
    db.rpc.mockResolvedValueOnce({ data: null, error: null });
    const retrieve = fakeRetrieve();
    const ai = aiResult({ assignments: [], unresolved: [] });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, {
        aiClient: ai,
        lock,
        skillRetrieve: retrieve,
      })
    ).resolves.toEqual({
      status: 'skipped',
      assignments: 0,
      unresolved: 0,
    });
    expect(ai.generateContent).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
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
    'records controlled unresolved for %s without calling AI or the Retriever',
    async (_, patch, reason) => {
      const db = makeSupabase(context(patch));
      const retrieve = fakeRetrieve();
      const ai = aiResult({ assignments: [], unresolved: [] });

      await expect(
        annotateProblemMarks(db.supabase, PROBLEM_ID, {
          aiClient: ai,
          lock,
          skillRetrieve: retrieve,
        })
      ).resolves.toMatchObject({ status: 'unresolved', assignments: 0 });

      expect(ai.generateContent).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
      expect(db.calls.at(-1)?.args.p_unresolved).toEqual([
        {
          role: 'target',
          kind: 'knowledge',
          part_index: null,
          reason,
        },
      ]);
      expect(db.calls.at(-1)?.args.p_skill_resolution).toBe('no_applicable');
      expect(db.calls.at(-1)?.args.p_skill_candidate_keys).toEqual([]);
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
        annotateProblemMarks(db.supabase, PROBLEM_ID, {
          aiClient: ai,
          lock,
          skillRetrieve: fakeRetrieve(),
        })
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
    const retrieve = fakeRetrieve();
    const ai = aiResult({ assignments: [], unresolved: [] });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, {
        aiClient: ai,
        lock,
        skillRetrieve: retrieve,
      })
    ).resolves.toEqual({
      status: 'failed',
      assignments: 0,
      unresolved: 0,
      error_code: 'REGISTRY_LOCK_MISMATCH',
    });
    expect(ai.generateContent).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
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
    const retrieve = fakeRetrieve();
    const ai = aiResult({ assignments: [], unresolved: [] });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, {
        aiClient: ai,
        lock,
        skillRetrieve: retrieve,
      })
    ).rejects.toThrow();
    expect(ai.generateContent).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
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
      annotateProblemMarks(db.supabase, PROBLEM_ID, {
        aiClient: ai,
        lock,
        skillRetrieve: fakeRetrieve(),
      })
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIClient } from '@/lib/ai/client';
import { annotateProblemMarks } from '@/lib/problem-marks/annotate';
import type { KnowledgeRegistryLock } from '@/lib/problem-marks/registry-artifact';

const PROBLEM_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_SHA = 'a'.repeat(40);
const CONTENT_SHA = 'b'.repeat(64);
const lock: KnowledgeRegistryLock = {
  repository: 'https://github.com/example/registry',
  source_sha: SOURCE_SHA,
  schema_version: 1,
  artifact_url: `https://raw.githubusercontent.com/example/registry/${SOURCE_SHA}/dist/registry.json`,
  content_sha256: CONTENT_SHA,
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
    if (name === 'get_problem_mark_annotation_context') {
      return { data: contextValue, error: null };
    }
    if (name === 'apply_problem_mark_annotation') {
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
    if (name === 'fail_problem_mark_annotation') {
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
  it('prompts with only active candidates returned for the current Subject', async () => {
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

    const prompt = vi.mocked(ai.generateContent).mock.calls[0][0].contents[0]
      .parts[0].text;
    expect(prompt).toContain('math.skill.parameter_separation');
    expect(prompt).toContain('math.knowledge.function');
    expect(prompt).not.toContain('physics.knowledge.motion');
    expect(db.calls.at(-1)?.args.p_assignments).toEqual([
      {
        mark_key: 'math.skill.parameter_separation',
        role: 'target',
        part_index: 1,
      },
    ]);
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

  it('fails closed without AI or state mutation when the DB revision mismatches the lock', async () => {
    const db = makeSupabase(
      context({ registry_content_sha256: 'c'.repeat(64) })
    );
    const ai = aiResult({ assignments: [], unresolved: [] });

    await expect(
      annotateProblemMarks(db.supabase, PROBLEM_ID, { aiClient: ai, lock })
    ).rejects.toThrow('REGISTRY_LOCK_MISMATCH');
    expect(ai.generateContent).not.toHaveBeenCalled();
    expect(db.calls.map(call => call.name)).toEqual([
      'get_problem_mark_annotation_context',
    ]);
  });

  it('records provider failures using the current semantic revision', async () => {
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
      name: 'fail_problem_mark_annotation',
      args: {
        p_problem_id: PROBLEM_ID,
        p_semantic_revision: 2,
        p_error_code: 'PROBLEM_MARK_PROVIDER_ERROR',
      },
    });
  });
});

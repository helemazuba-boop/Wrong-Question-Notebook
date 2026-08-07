import { describe, expect, it, vi } from 'vitest';
import { readProblemSemantics } from '@/lib/problem-marks/read';

const PROBLEM_ID = '11111111-1111-4111-8111-111111111111';

function semantics() {
  return {
    registry_revision: {
      id: 7,
      source_sha: 'a'.repeat(40),
      content_sha256: 'b'.repeat(64),
      schema_version: 1,
    },
    semantic_revision: 3,
    annotation_status: 'resolved',
    targets: [
      {
        part_index: 1,
        mark: {
          stable_key: 'math.knowledge.function',
          name: 'Function',
          kind: 'knowledge',
          subject: 'math',
          status: 'deprecated',
          parent: null,
        },
      },
    ],
    required: {
      knowledge: [],
      skills: [
        {
          part_index: null,
          mark: {
            stable_key: 'math.skill.parameter_separation',
            name: 'Parameter separation',
            kind: 'skill',
            subject: 'math',
            status: 'active',
            parent: null,
          },
        },
      ],
    },
    unresolved: [],
  };
}

describe('Problem semantics reader', () => {
  it('reads the stable RPC contract including deprecated resolved Marks', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: semantics(), error: null });
    const result = await readProblemSemantics({ rpc } as never, PROBLEM_ID);

    expect(rpc).toHaveBeenCalledWith('get_problem_semantics', {
      p_problem_id: PROBLEM_ID,
    });
    expect(result.targets[0].mark.status).toBe('deprecated');
    expect(result.required.skills[0].part_index).toBeNull();
  });

  it('rejects database and malformed contract results', async () => {
    await expect(
      readProblemSemantics(
        {
          rpc: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'permission denied' },
          }),
        } as never,
        PROBLEM_ID
      )
    ).rejects.toThrow('permission denied');

    await expect(
      readProblemSemantics(
        {
          rpc: vi.fn().mockResolvedValue({
            data: { ...semantics(), annotation_status: 'processing' },
            error: null,
          }),
        } as never,
        PROBLEM_ID
      )
    ).rejects.toThrow();
  });
});

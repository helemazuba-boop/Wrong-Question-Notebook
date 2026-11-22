import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock('@/lib/mcp/v2-readers', () => ({
  problemText: (text: string) => text.replace(/<[^>]*>/g, ''),
}));
import {
  authenticatedMarkService,
  authorizedAgentTask,
  loadAgentBundle,
  objectiveContext,
  taskToken,
} from '@/lib/problem-marks/agent-service';
const id = '11111111-1111-4111-8111-111111111111';
function task() {
  return {
    run_id: id,
    problem_id: id,
    semantic_revision: 1,
    registry_revision_id: 1,
    worker_id: 'worker',
    state: 'processing',
    lease_token: id,
    lease_until: new Date(Date.now() + 90000).toISOString(),
    deadline_at: new Date(Date.now() + 300000).toISOString(),
    session_id: null,
    prompt_state: 'new',
    bundle_sha256: 'a'.repeat(64),
    skill_version: '1.0.0',
    receipt: null,
    error_code: null,
    context: {
      title: 'Title',
      content: '<p>Statement</p>',
      subject_key: 'physics',
      initial_idea: 'Private idea',
      parts: [
        {
          index: 1,
          content: '<p>Part</p>',
          correct_answer: 'secret answer',
          answer_config: {
            choices: [{ id: 'A', text: 'Choice' }],
            correct_choice_id: 'A',
          },
        },
      ],
      assets: [
        { path: 'student', role: 'student_work' },
        { path: 'question', role: 'question' },
      ],
    },
  };
}
beforeEach(() => {
  vi.stubEnv('PROBLEM_MARKING_AGENT_SECRET', 's'.repeat(40));
  mocks.rpc.mockResolvedValue({ data: task(), error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe('Mark service task authority and objective projection', () => {
  it('uses an independent fail-closed service credential', () => {
    expect(
      authenticatedMarkService(
        new Request('http://wqn', {
          headers: { Authorization: 'Bearer ' + 's'.repeat(40) },
        })
      )
    ).toBe(true);
    expect(
      authenticatedMarkService(
        new Request('http://wqn', {
          headers: { Authorization: 'Bearer user-token' },
        })
      )
    ).toBe(false);
    vi.stubEnv('PROBLEM_MARKING_AGENT_SECRET', 'short');
    expect(authenticatedMarkService(new Request('http://wqn'))).toBe(false);
  });
  it('binds credentials to one run without exposing internal control', async () => {
    expect(taskToken(id)).not.toBe(
      taskToken('22222222-2222-4222-8222-222222222222')
    );
    await expect(authorizedAgentTask(id, 'a'.repeat(64))).rejects.toThrow(
      'TASK_NOT_AUTHORIZED'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect((await authorizedAgentTask(id, taskToken(id))).run_id).toBe(id);
  });
  it('allows old receipt reads but rejects new work after the deadline', async () => {
    const old = {
      ...task(),
      deadline_at: new Date(Date.now() - 1).toISOString(),
    };
    mocks.rpc.mockResolvedValue({ data: old, error: null });
    await expect(authorizedAgentTask(id, taskToken(id))).rejects.toThrow(
      'TASK_NOT_ACTIVE'
    );
    expect((await authorizedAgentTask(id, taskToken(id), false)).run_id).toBe(
      id
    );
  });
  it('provides exact evidence text while excluding personal context and scoring', () => {
    const value = objectiveContext(task());
    expect(value.evidence_fields['parts.1.content']).toBe('Part');
    expect(value.evidence_fields.content).toBe('Statement');
    expect(value).not.toHaveProperty('initial_idea');
    expect(value.parts[0]).not.toHaveProperty('correct_answer');
    expect(value.images).toHaveLength(1);
    expect(value.images[0].asset.path).toBe('question');
  });
  it('loads the exact artifact pinned by the WQN lock', async () => {
    const result = await loadAgentBundle();
    expect(result.sha256).toBe(result.lock.agent_marking?.artifact_sha256);
    // The 题型笔记 corpus replaced the 解题觉醒 corpus. Assert the invariant the
    // loader actually enforces — one document per active Mark — rather than a
    // corpus size that changes with every import.
    const active = result.bundle.registry.marks.filter(
      (mark: { status: string }) => mark.status === 'active'
    );
    expect(result.bundle.documents).toHaveLength(active.length);
    expect(
      new Set(
        result.bundle.documents.map((d: { stable_key: string }) => d.stable_key)
      ).size
    ).toBe(active.length);
  });
});

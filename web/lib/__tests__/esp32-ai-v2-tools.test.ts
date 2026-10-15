import { beforeEach, describe, it, expect, vi } from 'vitest';
import { buildAiToolExecutor } from '@/app/api/esp32/ai/transcribe-chat/v2-tools';
const { read, write, list, search } = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/mcp/v2-readers', () => ({ readV2: read }));
vi.mock('@/lib/ai-tools/voice-write', async () => ({
  ...(await vi.importActual('@/lib/ai-tools/voice-write')),
  executeVoiceWrite: write,
}));
vi.mock('@/lib/todos', async () => ({
  ...(await vi.importActual('@/lib/todos')),
  loadTodos: list,
}));
vi.mock('@/lib/notebooks', async () => ({
  ...(await vi.importActual('@/lib/notebooks')),
  searchUserProblems: search,
}));
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const context = {
  userId: user,
  deviceId: device,
  conversationId: user,
  requestId: 'turn_request_0001',
  timeContext: { now: '2026-10-14T15:30:00Z', timezone: 'Asia/Shanghai' },
};
beforeEach(() => vi.clearAllMocks());
describe('eight device voice tools', () => {
  it.each([
    'list_authorized_notebooks',
    'list_authorized_word_decks',
    'create_word_deck',
    'add_word_entry',
    'search_words',
    'submit_problem_update',
    'update_notebook_note',
  ])('rejects removed or unexposed %s', async name => {
    expect((await buildAiToolExecutor(context)(name, '{}')).ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('uses filter-aware readers to browse sets with stable pagination', async () => {
    read.mockResolvedValue({
      items: [{ id: user, title: 'Smart', problem_count: 3 }],
      has_more: true,
      next_cursor: '20',
      total: 23,
    });
    const result = await buildAiToolExecutor(context)(
      'list_problem_sets',
      '{}'
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        problem_sets: [{ problem_count: 3 }],
        next_cursor: '20',
        total: 23,
      },
    });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user }),
      'list_problem_sets',
      {}
    );
  });
  it('passes the selected set and returned cursor to the same reader', async () => {
    read.mockResolvedValue({
      items: [],
      has_more: false,
      next_cursor: null,
      total: 0,
    });
    const result = await buildAiToolExecutor(context)(
      'list_problem_set_problems',
      JSON.stringify({ problem_set_id: user, cursor: '20', limit: 10 })
    );
    expect(result).toMatchObject({
      ok: true,
      data: { problems: [], has_more: false },
    });
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      'list_problem_set_problems',
      { problem_set_id: user, cursor: '20', limit: 10 }
    );
  });
  it('preserves structured options, evidence and missing images in voice detail', async () => {
    const problem = {
      id: user,
      parts: [{ mcq_choices: [{ id: 'A', text: 'first' }] }],
      image_completion_required: true,
      evidence: { answer_origin: null },
    };
    read.mockResolvedValue({ item: problem });
    expect(
      await buildAiToolExecutor(context)(
        'get_problem_detail',
        JSON.stringify({ problem_id: user })
      )
    ).toMatchObject({ ok: true, data: { problem } });
  });
  it('passes stable identity and the trusted time context to transactional writes', async () => {
    const data = {
      todo: { id: user },
      action: { type: 'todo_created', todo_id: user },
    };
    write.mockResolvedValue(data);
    const execute = buildAiToolExecutor(context),
      args = { title: '复习数学', due: { date: 'tomorrow' } };
    expect(
      await execute('create_todo', JSON.stringify(args), { callId: 'call-1' })
    ).toMatchObject({ ok: true, data, action: data.action });
    await execute('create_todo', JSON.stringify(args), { callId: 'call-1' });
    expect(write.mock.calls[0][3]).toBe(write.mock.calls[1][3]);
    expect(write.mock.calls[0]).toEqual([
      expect.objectContaining({
        userId: user,
        deviceId: device,
        conversationId: user,
      }),
      'create_todo',
      args,
      expect.stringMatching(/^voice_[a-f0-9]{48}$/),
      context.timeContext,
    ]);
  });
  it('accepts a signed relay operation id instead of inventing another one', async () => {
    write.mockResolvedValue({ todo: { id: user } });
    await buildAiToolExecutor(context)('create_todo', '{"title":"复习"}', {
      callId: 'call',
      requestId: 'tool_request_0001',
    });
    expect(write.mock.calls[0][3]).toBe('tool_request_0001');
  });
  it('fails before mutation when identity or arguments are missing', async () => {
    expect(
      (await buildAiToolExecutor(context)('create_todo', '{"title":"复习"}'))
        .error?.code
    ).toBe('write_identity_required');
    expect(
      (
        await buildAiToolExecutor(context)('create_todo', '{"title":""}', {
          callId: 'call',
        })
      ).error?.code
    ).toBe('invalid_arguments');
    expect(write).not.toHaveBeenCalled();
  });
  it('rejects conflicting dates and retired Word links', async () => {
    for (const fields of [
      { due: { date: 'tomorrow' }, due_at: '2026-10-15T10:00:00Z' },
      { word_deck_id: device },
      { due: { offset_minutes: 30, date: 'tomorrow' } },
    ]) {
      expect(
        (
          await buildAiToolExecutor(context)(
            'create_todo',
            JSON.stringify({ title: '复习', ...fields }),
            { callId: 'call' }
          )
        ).error?.code
      ).toBe('invalid_arguments');
    }
    expect(write).not.toHaveBeenCalled();
  });
  it('surfaces unknown outcomes and permission failures without announcing success', async () => {
    write.mockRejectedValue({
      code: 'unknown_outcome',
      message: '原写入结果未知',
    });
    const result = await buildAiToolExecutor(context)(
      'create_todo',
      '{"title":"复习"}',
      { callId: 'call' }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unknown_outcome' },
    });
    expect(result.display).toContain('failed');
  });
});

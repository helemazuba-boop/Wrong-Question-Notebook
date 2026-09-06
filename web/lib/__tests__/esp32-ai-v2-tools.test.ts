import { beforeEach, describe, expect, it, vi } from 'vitest';

// The voice executor now runs registry handlers, so only the shared lib
// functions are mocked; everything else (schemas, dispatch, error mapping)
// is the production code under test.
const mocks = vi.hoisted(() => ({
  listAuthorizedNotebooks: vi.fn(),
  searchUserProblems: vi.fn(),
  loadTodos: vi.fn(),
  createTodoFromAi: vi.fn(),
  updateTodoStatusFromAi: vi.fn(),
  listAuthorizedWordDecks: vi.fn(),
  createWordDeck: vi.fn(),
  searchWords: vi.fn(),
}));

vi.mock('@/lib/notebooks', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/notebooks')>()),
  listAuthorizedNotebooks: mocks.listAuthorizedNotebooks,
  searchUserProblems: mocks.searchUserProblems,
}));

vi.mock('@/lib/todos', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/todos')>()),
  loadTodos: mocks.loadTodos,
  createTodoFromAi: mocks.createTodoFromAi,
  updateTodoStatusFromAi: mocks.updateTodoStatusFromAi,
}));

vi.mock('@/lib/words', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/words')>()),
  listAuthorizedWordDecks: mocks.listAuthorizedWordDecks,
  createWordDeck: mocks.createWordDeck,
  searchWords: mocks.searchWords,
}));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

import { buildAiToolExecutor } from '@/app/api/esp32/ai/transcribe-chat/v2-tools';
import { findMcpTool } from '@/lib/mcp/tool-registry';

describe('ESP32 v2 tool executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      'list_authorized_notebooks',
      mocks.listAuthorizedNotebooks,
      '{}',
      { notebooks: [{ id: 'notebook-1', title: '数学' }] },
      { notebooks: [{ id: 'notebook-1', title: '数学' }] },
    ],
    [
      'search_user_problems',
      mocks.searchUserProblems,
      JSON.stringify({ query: '函数' }),
      { problems: [{ id: 'problem-1', title: '函数题' }] },
      { problems: [{ id: 'problem-1', title: '函数题' }] },
    ],
    [
      // The registry handler wraps loadTodos rows in {todos}; the voice
      // path used to receive the same shape via listTodosForAi.
      'list_todos',
      mocks.loadTodos,
      '{}',
      [{ id: 'todo-1', title: '复习数学' }],
      { todos: [{ id: 'todo-1', title: '复习数学' }] },
    ],
    [
      'list_authorized_word_decks',
      mocks.listAuthorizedWordDecks,
      '{}',
      { decks: [{ id: 'deck-1', title: 'CET-4' }] },
      { decks: [{ id: 'deck-1', title: 'CET-4' }] },
    ],
    [
      'search_words',
      mocks.searchWords,
      JSON.stringify({ q: 'derive' }),
      { words: [{ id: 'word-1', word: 'derive' }], next_letters: [] },
      { words: [{ id: 'word-1', word: 'derive' }], next_letters: [] },
    ],
  ])(
    'returns query data from %s',
    async (name, implementation, rawArgs, libResult, expectedData) => {
      implementation.mockResolvedValueOnce(libResult);
      const execute = buildAiToolExecutor({ userId: 'user-1' });

      const result = await execute(name, rawArgs);

      expect(result).toMatchObject({ ok: true, data: expectedData });
      expect(result.error).toBeUndefined();
    }
  );

  it('returns mutation data and action for the model and device', async () => {
    const todo = { id: 'todo-1', title: '复习数学', status: 'pending' };
    const action = {
      type: 'todo_created',
      todo_id: 'todo-1',
      title: '复习数学',
    };
    mocks.createTodoFromAi.mockResolvedValueOnce({ todo, action });
    const execute = buildAiToolExecutor({ userId: 'user-1' });

    const result = await execute(
      'create_todo',
      JSON.stringify({ title: '复习数学' })
    );

    expect(result).toMatchObject({
      ok: true,
      display: 'Todo created',
      data: { todo, action },
      action,
    });
  });

  it('runs read-only registry handlers that own their queries', async () => {
    const problem = { id: 'problem-1', title: '函数题' };
    const handler = findMcpTool('get_problem_detail')!;
    const spy = vi.spyOn(handler, 'handler').mockResolvedValueOnce({ problem });
    const execute = buildAiToolExecutor({ userId: 'user-1' });

    const result = await execute(
      'get_problem_detail',
      JSON.stringify({ problem_id: 'problem-1' })
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, data: { problem } });
  });

  it('surfaces schema violations to the model instead of failing silently', async () => {
    const execute = buildAiToolExecutor({ userId: 'user-1' });

    const result = await execute('create_todo', JSON.stringify({ title: '' }));

    expect(result).toMatchObject({
      ok: false,
      display: 'Creating todo failed',
      error: { code: 'invalid_arguments' },
    });
    expect(result.error?.message).toContain('title');
    expect(mocks.createTodoFromAi).not.toHaveBeenCalled();
  });

  it('propagates handler errors with code and message', async () => {
    mocks.createTodoFromAi.mockRejectedValueOnce(
      Object.assign(new Error('AI has no permission to write that notebook'), {
        code: 'notebook_permission_denied',
      })
    );
    const execute = buildAiToolExecutor({ userId: 'user-1' });

    const result = await execute(
      'create_todo',
      JSON.stringify({ title: '复习数学' })
    );

    expect(result).toMatchObject({
      ok: false,
      display: 'Creating todo failed',
      error: {
        code: 'notebook_permission_denied',
        message: 'AI has no permission to write that notebook',
      },
    });
  });

  it('rejects tools outside the voice allow-list and unknown names', async () => {
    const execute = buildAiToolExecutor({ userId: 'user-1' });

    const registryOnly = await execute(
      'get_todo',
      JSON.stringify({ todo_id: 'todo-1' })
    );
    const unknown = await execute('make_coffee', '{}');

    expect(registryOnly).toMatchObject({ ok: false });
    expect(registryOnly.display).toBe('Unknown tool: get_todo');
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.display).toBe('Unknown tool: make_coffee');
    expect(mocks.loadTodos).not.toHaveBeenCalled();
  });

  it('passes voice provenance into the shared tool context', async () => {
    mocks.createTodoFromAi.mockResolvedValueOnce({
      todo: { id: 'todo-2', title: '背单词' },
      action: { type: 'todo_created', todo_id: 'todo-2', title: '背单词' },
    });
    const execute = buildAiToolExecutor({
      userId: 'user-1',
      conversationId: 'conv-1',
      deviceId: 'device-1',
    });

    await execute('create_todo', JSON.stringify({ title: '背单词' }));

    expect(mocks.createTodoFromAi).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversationId: 'conv-1',
        deviceId: 'device-1',
      }),
      expect.objectContaining({ title: '背单词' })
    );
  });
});

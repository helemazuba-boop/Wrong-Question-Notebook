import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAuthorizedNotebooks: vi.fn(),
  createNotebookNoteFromAi: vi.fn(),
  searchUserProblems: vi.fn(),
  getProblemDetail: vi.fn(),
  listTodosForAi: vi.fn(),
  createTodoFromAi: vi.fn(),
  updateTodoStatusFromAi: vi.fn(),
  listAuthorizedWordDecks: vi.fn(),
  createWordDeck: vi.fn(),
  addWordEntryToDeck: vi.fn(),
  searchWords: vi.fn(),
}));

vi.mock('@/lib/notebooks', () => ({
  listAuthorizedNotebooks: mocks.listAuthorizedNotebooks,
  createNotebookNoteFromAi: mocks.createNotebookNoteFromAi,
  searchUserProblems: mocks.searchUserProblems,
  getProblemDetail: mocks.getProblemDetail,
}));

vi.mock('@/lib/todos', () => ({
  listTodosForAi: mocks.listTodosForAi,
  createTodoFromAi: mocks.createTodoFromAi,
  updateTodoStatusFromAi: mocks.updateTodoStatusFromAi,
}));

vi.mock('@/lib/words', () => ({
  listAuthorizedWordDecks: mocks.listAuthorizedWordDecks,
  createWordDeck: mocks.createWordDeck,
  addWordEntryToDeck: mocks.addWordEntryToDeck,
  searchWords: mocks.searchWords,
}));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

import { buildAiToolExecutor } from '@/app/api/esp32/ai/transcribe-chat/v2-tools';

describe('ESP32 v2 tool executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      'list_authorized_notebooks',
      mocks.listAuthorizedNotebooks,
      { notebooks: [{ id: 'notebook-1', title: '数学' }] },
    ],
    [
      'search_user_problems',
      mocks.searchUserProblems,
      { problems: [{ id: 'problem-1', title: '函数题' }] },
    ],
    [
      'get_problem_detail',
      mocks.getProblemDetail,
      { problem: { id: 'problem-1', solution_text: '解析' } },
    ],
    [
      'list_todos',
      mocks.listTodosForAi,
      { todos: [{ id: 'todo-1', title: '复习数学' }] },
    ],
    [
      'list_word_decks',
      mocks.listAuthorizedWordDecks,
      { decks: [{ id: 'deck-1', title: 'CET-4' }] },
    ],
    [
      'search_words',
      mocks.searchWords,
      { words: [{ id: 'word-1', word: 'derive' }], next_letters: [] },
    ],
  ])('returns query data from %s', async (name, implementation, data) => {
    implementation.mockResolvedValueOnce(data);
    const execute = buildAiToolExecutor({ userId: 'user-1' });

    const result = await execute(name, '{}');

    expect(result).toMatchObject({ ok: true, data });
  });

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

    expect(result).toMatchObject({ ok: true, data: todo, action });
  });
});

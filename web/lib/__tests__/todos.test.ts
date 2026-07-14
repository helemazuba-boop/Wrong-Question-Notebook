import { describe, expect, it, vi } from 'vitest';
import {
  createTodoFromAi,
  loadEsp32TodoTimeline,
  TodoToolError,
  updateTodoStatusFromAi,
} from '@/lib/todos';

const TODO_ROW = {
  id: 'todo-1',
  title: '复习链式法则',
  description: null,
  status: 'pending',
  priority: 'normal',
  due_at: null,
  reminder_at: null,
  subject_id: null,
  problem_set_id: null,
  problem_id: null,
  notebook_id: null,
  note_id: null,
  source: 'ai',
  created_by: 'ai',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  completed_at: null,
  cancelled_at: null,
  subjects: null,
};

function createQuery(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
}

function createInsertQuery(result: unknown) {
  return {
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
  };
}

function createUpdateQuery(result: unknown) {
  return {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
  };
}

function createTimelineQuery(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
}

describe('Todo AI helpers', () => {
  it('rejects Todo creation linked to another user subject', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'subjects') {
          return createQuery({ data: null, error: null });
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as any;

    await expect(
      createTodoFromAi(
        { userId: 'user-1', supabase, conversationId: 'conv-1' },
        {
          title: '复习链式法则',
          subject_id: '00000000-0000-4000-8000-000000000001',
        }
      )
    ).rejects.toMatchObject({
      code: 'subject_not_found',
      status: 404,
    });
  });

  it('creates todo_created action after a valid AI Todo write', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'todos') {
          return createInsertQuery({ data: TODO_ROW, error: null });
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as any;

    const result = await createTodoFromAi(
      { userId: 'user-1', supabase, conversationId: 'conv-1' },
      { title: '复习链式法则' }
    );

    expect(result.action).toEqual({
      type: 'todo_created',
      todo_id: 'todo-1',
      title: '复习链式法则',
      status: 'pending',
      due_at: null,
      reminder_at: null,
    });
  });

  it('updates status and returns todo_status_updated action', async () => {
    const completedRow = {
      ...TODO_ROW,
      status: 'completed',
      completed_at: '2026-06-01T00:01:00.000Z',
    };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table !== 'todos') throw new Error(`unexpected table ${table}`);
        if (supabase.from.mock.calls.length === 1) {
          return createQuery({ data: TODO_ROW, error: null });
        }
        return createUpdateQuery({ data: completedRow, error: null });
      }),
    } as any;

    const result = await updateTodoStatusFromAi(
      { userId: 'user-1', supabase },
      { todo_id: 'todo-1', status: 'completed' }
    );

    expect(result.action).toEqual({
      type: 'todo_status_updated',
      todo_id: 'todo-1',
      title: '复习链式法则',
      status: 'completed',
    });
  });

  it('throws TodoToolError for empty titles', async () => {
    const supabase = { from: vi.fn() } as any;

    await expect(
      createTodoFromAi({ userId: 'user-1', supabase }, { title: '   ' })
    ).rejects.toBeInstanceOf(TodoToolError);
  });

  it('selects the pending Todo closest to server time for ESP32 timeline', async () => {
    const supabase = {
      from: vi.fn(() =>
        createTimelineQuery({
          data: [
            {
              ...TODO_ROW,
              id: 'todo-early',
              due_at: '2026-06-01T08:00:00.000Z',
            },
            {
              ...TODO_ROW,
              id: 'todo-nearest',
              due_at: '2026-06-01T12:10:00.000Z',
            },
            {
              ...TODO_ROW,
              id: 'todo-late',
              due_at: '2026-06-01T20:00:00.000Z',
            },
          ],
          error: null,
        })
      ),
    } as any;

    const result = await loadEsp32TodoTimeline(supabase, 'user-1', {
      limit: 3,
      server_time: '2026-06-01T12:00:00.000Z',
    });

    expect(result.scope).toBe('timeline');
    expect(result.selected_todo_id).toBe('todo-nearest');
    expect(result.todos.map(todo => todo.id)).toEqual([
      'todo-early',
      'todo-nearest',
      'todo-late',
    ]);
  });

  it('returns cursor windows with edge selection for ESP32 timeline browsing', async () => {
    const supabase = {
      from: vi.fn(() =>
        createTimelineQuery({
          data: Array.from({ length: 6 }, (_, index) => ({
            ...TODO_ROW,
            id: `todo-${index}`,
            due_at: `2026-06-01T0${index}:00:00.000Z`,
          })),
          error: null,
        })
      ),
    } as any;

    const initial = await loadEsp32TodoTimeline(supabase, 'user-1', {
      limit: 2,
      server_time: '2026-06-01T03:00:00.000Z',
    });

    expect(initial.todos.map(todo => todo.id)).toEqual(['todo-2', 'todo-3']);
    expect(initial.selected_todo_id).toBe('todo-3');
    expect(initial.has_earlier).toBe(true);
    expect(initial.has_later).toBe(true);
    expect(initial.previous_cursor).toBeTruthy();
    expect(initial.next_cursor).toBeTruthy();

    const previous = await loadEsp32TodoTimeline(supabase, 'user-1', {
      limit: 2,
      cursor: initial.previous_cursor,
      server_time: '2026-06-01T03:00:00.000Z',
    });
    expect(previous.todos.map(todo => todo.id)).toEqual(['todo-0', 'todo-1']);
    expect(previous.selected_index).toBe(1);
    expect(previous.selected_todo_id).toBe('todo-1');

    const next = await loadEsp32TodoTimeline(supabase, 'user-1', {
      limit: 2,
      cursor: initial.next_cursor,
      server_time: '2026-06-01T03:00:00.000Z',
    });
    expect(next.todos.map(todo => todo.id)).toEqual(['todo-4', 'todo-5']);
    expect(next.selected_index).toBe(0);
    expect(next.selected_todo_id).toBe('todo-4');
  });
});

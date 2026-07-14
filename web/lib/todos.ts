import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import type { Database, Json } from '@/lib/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

export type TodoStatus = 'pending' | 'completed' | 'cancelled';
export type TodoPriority = 'low' | 'normal' | 'high';
export type TodoSource = 'manual' | 'ai' | 'device' | 'system';
export type TodoCreatedBy = 'user' | 'ai' | 'device' | 'system';

export interface TodoListItem {
  id: string;
  title: string;
  description: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  due_at: string | null;
  reminder_at: string | null;
  subject_id: string | null;
  subject_name: string;
  problem_set_id: string | null;
  problem_id: string | null;
  notebook_id: string | null;
  note_id: string | null;
  source: TodoSource;
  created_by: TodoCreatedBy;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface Esp32TodoItem {
  id: string;
  title: string;
  description: string;
  status: 'pending';
  priority: TodoPriority;
  due_at: string | null;
  reminder_at: string | null;
  timeline_at: string | null;
  subject_name: string;
  updated_at: string;
}

export interface Esp32TodoTimeline {
  scope: 'timeline';
  todos: Esp32TodoItem[];
  selected_index: number;
  selected_todo_id: string | null;
  previous_cursor: string | null;
  next_cursor: string | null;
  has_earlier: boolean;
  has_later: boolean;
  has_more: boolean;
  total: number;
  server_time: string;
}

export interface TodoCreatedAction {
  type: 'todo_created';
  todo_id: string;
  title: string;
  status: 'pending';
  due_at: string | null;
  reminder_at: string | null;
}

export interface TodoStatusUpdatedAction {
  type: 'todo_status_updated';
  todo_id: string;
  title: string;
  status: TodoStatus;
}

export type TodoAiAction = TodoCreatedAction | TodoStatusUpdatedAction;

export interface TodoToolContext {
  userId: string;
  supabase: SupabaseClient<Database>;
  conversationId?: string | null;
  deviceId?: string | null;
}

export class TodoToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'TodoToolError';
  }
}

const VALID_STATUSES: TodoStatus[] = ['pending', 'completed', 'cancelled'];
const VALID_PRIORITIES: TodoPriority[] = ['low', 'normal', 'high'];
const TODO_SELECT_COLUMNS =
  'id, title, description, status, priority, due_at, reminder_at, subject_id, problem_set_id, problem_id, notebook_id, note_id, source, created_by, created_at, updated_at, completed_at, cancelled_at, subjects(name)';
const ESP32_TIMELINE_MAX_ROWS = 200;

function normalizeStatus(value: string): TodoStatus {
  if (VALID_STATUSES.includes(value as TodoStatus)) {
    return value as TodoStatus;
  }
  return 'pending';
}

function normalizePriority(value: string): TodoPriority {
  if (VALID_PRIORITIES.includes(value as TodoPriority)) {
    return value as TodoPriority;
  }
  return 'normal';
}

function normalizeSource(value: string): TodoSource {
  if (['manual', 'ai', 'device', 'system'].includes(value)) {
    return value as TodoSource;
  }
  return 'manual';
}

function normalizeCreatedBy(value: string): TodoCreatedBy {
  if (['user', 'ai', 'device', 'system'].includes(value)) {
    return value as TodoCreatedBy;
  }
  return 'user';
}

function sanitizeTitle(title: string): string {
  const value = title.trim().slice(0, 120);
  if (!value) {
    throw new TodoToolError('invalid_request', 'Todo title is required', 400);
  }
  return value;
}

function sanitizeDescription(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 2000);
  return trimmed || null;
}

function sanitizeTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TodoToolError('invalid_request', 'Invalid timestamp', 400);
  }
  return parsed.toISOString();
}

function limitWithin(
  value: number | undefined,
  min: number,
  max: number
): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value || max), min), max);
}

function parseOptionalTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TodoToolError('invalid_request', 'Invalid timestamp', 400);
  }
  return parsed.toISOString();
}

function mapTodoRow(row: any): TodoListItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: normalizeStatus(row.status),
    priority: normalizePriority(row.priority),
    due_at: row.due_at,
    reminder_at: row.reminder_at,
    subject_id: row.subject_id,
    subject_name: row.subjects?.name || '',
    problem_set_id: row.problem_set_id,
    problem_id: row.problem_id,
    notebook_id: row.notebook_id,
    note_id: row.note_id,
    source: normalizeSource(row.source),
    created_by: normalizeCreatedBy(row.created_by),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
  };
}

async function ensureSubjectOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId?: string | null
) {
  if (!subjectId) return;
  const { data, error } = await supabase
    .from('subjects')
    .select('id')
    .eq('id', subjectId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  if (!data)
    throw new TodoToolError('subject_not_found', 'Subject not found', 404);
}

async function ensureProblemSetOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemSetId?: string | null
) {
  if (!problemSetId) return;
  const { data, error } = await supabase
    .from('problem_sets')
    .select('id')
    .eq('id', problemSetId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  if (!data) {
    throw new TodoToolError(
      'problem_set_not_found',
      'Problem set not found',
      404
    );
  }
}

async function ensureProblemOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemId?: string | null
) {
  if (!problemId) return;
  const { data, error } = await supabase
    .from('problems')
    .select('id')
    .eq('id', problemId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  if (!data)
    throw new TodoToolError('problem_not_found', 'Problem not found', 404);
}

async function ensureNotebookOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId?: string | null
) {
  if (!notebookId) return;
  const { data, error } = await supabase
    .from('notebooks')
    .select('id')
    .eq('id', notebookId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  if (!data)
    throw new TodoToolError('notebook_not_found', 'Notebook not found', 404);
}

async function ensureNotebookNoteOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  noteId?: string | null
) {
  if (!noteId) return;
  const { data, error } = await supabase
    .from('notebook_notes')
    .select('id')
    .eq('id', noteId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  if (!data) {
    throw new TodoToolError(
      'notebook_note_not_found',
      'Notebook note not found',
      404
    );
  }
}

async function verifyTodoLinks(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: {
    subject_id?: string | null;
    problem_set_id?: string | null;
    problem_id?: string | null;
    notebook_id?: string | null;
    note_id?: string | null;
  }
) {
  await Promise.all([
    ensureSubjectOwner(supabase, userId, input.subject_id),
    ensureProblemSetOwner(supabase, userId, input.problem_set_id),
    ensureProblemOwner(supabase, userId, input.problem_id),
    ensureNotebookOwner(supabase, userId, input.notebook_id),
    ensureNotebookNoteOwner(supabase, userId, input.note_id),
  ]);
}

export async function loadTodos(
  supabase: SupabaseClient<Database>,
  userId: string,
  filters: {
    status?: TodoStatus | 'all';
    subject_id?: string | null;
    due_before?: string | null;
    limit?: number;
  } = {}
): Promise<TodoListItem[]> {
  const status = filters.status || 'pending';
  const limit = limitWithin(filters.limit, 1, 50);
  const dueBefore = parseOptionalTimestamp(filters.due_before);

  let query = supabase
    .from('todos')
    .select(TODO_SELECT_COLUMNS)
    .eq('user_id', userId)
    .is('archived_at', null)
    .limit(limit);

  if (status !== 'all') query = query.eq('status', status);
  if (filters.subject_id) query = query.eq('subject_id', filters.subject_id);
  if (dueBefore) query = query.lte('due_at', dueBefore);

  const { data, error } = await query
    .order('status', { ascending: false })
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('updated_at', { ascending: false });

  if (error) throw new TodoToolError('database_error', error.message, 500);
  return (data || []).map(mapTodoRow);
}

export async function getTodoById(
  supabase: SupabaseClient<Database>,
  userId: string,
  todoId: string
): Promise<TodoListItem> {
  const { data, error } = await supabase
    .from('todos')
    .select(TODO_SELECT_COLUMNS)
    .eq('id', todoId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  if (!data) throw new TodoToolError('todo_not_found', 'Todo not found', 404);
  return mapTodoRow(data);
}

export async function createTodo(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: {
    title: string;
    description?: string | null;
    priority?: TodoPriority;
    due_at?: string | null;
    reminder_at?: string | null;
    subject_id?: string | null;
    problem_set_id?: string | null;
    problem_id?: string | null;
    notebook_id?: string | null;
    note_id?: string | null;
    source?: TodoSource;
    created_by?: TodoCreatedBy;
    source_conversation_id?: string | null;
    source_device_id?: string | null;
    metadata?: Json;
  }
): Promise<TodoListItem> {
  await verifyTodoLinks(supabase, userId, input);

  const insertPayload: Database['public']['Tables']['todos']['Insert'] = {
    user_id: userId,
    title: sanitizeTitle(input.title),
    description: sanitizeDescription(input.description),
    priority: input.priority || 'normal',
    due_at: sanitizeTimestamp(input.due_at),
    reminder_at: sanitizeTimestamp(input.reminder_at),
    subject_id: input.subject_id || null,
    problem_set_id: input.problem_set_id || null,
    problem_id: input.problem_id || null,
    notebook_id: input.notebook_id || null,
    note_id: input.note_id || null,
    source: input.source || 'manual',
    created_by: input.created_by || 'user',
    source_conversation_id: input.source_conversation_id || null,
    source_device_id: input.source_device_id || null,
    metadata:
      input.metadata && typeof input.metadata === 'object'
        ? input.metadata
        : {},
  };

  const { data, error } = await supabase
    .from('todos')
    .insert(insertPayload)
    .select(TODO_SELECT_COLUMNS)
    .single();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  return mapTodoRow(data);
}

export async function updateTodo(
  supabase: SupabaseClient<Database>,
  userId: string,
  todoId: string,
  input: {
    title?: string;
    description?: string | null;
    priority?: TodoPriority;
    due_at?: string | null;
    reminder_at?: string | null;
    subject_id?: string | null;
    problem_set_id?: string | null;
    problem_id?: string | null;
    notebook_id?: string | null;
    note_id?: string | null;
    metadata?: Json;
  }
): Promise<TodoListItem> {
  await getTodoById(supabase, userId, todoId);
  await verifyTodoLinks(supabase, userId, input);

  const updatePayload: Database['public']['Tables']['todos']['Update'] = {};
  if (input.title !== undefined)
    updatePayload.title = sanitizeTitle(input.title);
  if (input.description !== undefined) {
    updatePayload.description = sanitizeDescription(input.description);
  }
  if (input.priority !== undefined) updatePayload.priority = input.priority;
  if (input.due_at !== undefined)
    updatePayload.due_at = sanitizeTimestamp(input.due_at);
  if (input.reminder_at !== undefined) {
    updatePayload.reminder_at = sanitizeTimestamp(input.reminder_at);
  }
  if (input.subject_id !== undefined)
    updatePayload.subject_id = input.subject_id;
  if (input.problem_set_id !== undefined) {
    updatePayload.problem_set_id = input.problem_set_id;
  }
  if (input.problem_id !== undefined)
    updatePayload.problem_id = input.problem_id;
  if (input.notebook_id !== undefined)
    updatePayload.notebook_id = input.notebook_id;
  if (input.note_id !== undefined) updatePayload.note_id = input.note_id;
  if (input.metadata !== undefined) updatePayload.metadata = input.metadata;

  const { data, error } = await supabase
    .from('todos')
    .update(updatePayload)
    .eq('id', todoId)
    .eq('user_id', userId)
    .select(TODO_SELECT_COLUMNS)
    .single();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  return mapTodoRow(data);
}

export async function updateTodoStatus(
  supabase: SupabaseClient<Database>,
  userId: string,
  todoId: string,
  status: TodoStatus
): Promise<TodoListItem> {
  const current = await getTodoById(supabase, userId, todoId);
  if (current.status === status) return current;

  const now = new Date().toISOString();
  const updatePayload: Database['public']['Tables']['todos']['Update'] = {
    status,
    completed_at: status === 'completed' ? now : null,
    cancelled_at: status === 'cancelled' ? now : null,
  };

  const { data, error } = await supabase
    .from('todos')
    .update(updatePayload)
    .eq('id', todoId)
    .eq('user_id', userId)
    .select(TODO_SELECT_COLUMNS)
    .single();

  if (error) throw new TodoToolError('database_error', error.message, 500);
  return mapTodoRow(data);
}

export async function completeTodo(
  supabase: SupabaseClient<Database>,
  userId: string,
  todoId: string
): Promise<TodoListItem> {
  return updateTodoStatus(supabase, userId, todoId, 'completed');
}

export async function cancelTodo(
  supabase: SupabaseClient<Database>,
  userId: string,
  todoId: string
): Promise<TodoListItem> {
  return updateTodoStatus(supabase, userId, todoId, 'cancelled');
}

export async function loadEsp32TodayTodos(
  supabase: SupabaseClient<Database>,
  userId: string,
  limit = 8
): Promise<Esp32TodoItem[]> {
  const timeline = await loadEsp32TodoTimeline(supabase, userId, { limit });

  return timeline.todos;
}

function getTodoTimelineAt(todo: TodoListItem): string | null {
  return (
    todo.due_at ||
    todo.reminder_at ||
    todo.created_at ||
    todo.updated_at ||
    null
  );
}

function getTodoTimelineTime(todo: TodoListItem): number {
  const timestamp = getTodoTimelineAt(todo);
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function compareTodoTimeline(a: TodoListItem, b: TodoListItem): number {
  const timeDiff = getTodoTimelineTime(a) - getTodoTimelineTime(b);
  if (timeDiff !== 0) return timeDiff;
  return Date.parse(a.updated_at) - Date.parse(b.updated_at);
}

function encodeTodoCursor(offset: number, selected: 'first' | 'last'): string {
  return Buffer.from(JSON.stringify({ offset, selected }), 'utf8').toString(
    'base64url'
  );
}

function parseTodoCursor(
  value?: string | null
): { offset: number; selected?: 'first' | 'last' } | null {
  if (!value) return null;
  const numericOffset = Number.parseInt(value, 10);
  if (Number.isFinite(numericOffset)) {
    return { offset: Math.max(numericOffset, 0) };
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const offset = Number.parseInt(String(parsed?.offset ?? 0), 10);
    const selected = parsed?.selected === 'last' ? 'last' : 'first';
    return {
      offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
      selected,
    };
  } catch {
    throw new TodoToolError('invalid_request', 'Invalid Todo cursor', 400);
  }
}

function findClosestTodoIndex(
  todos: TodoListItem[],
  serverTime: string
): number {
  if (todos.length === 0) return -1;
  const now = Date.parse(serverTime);
  let selectedIndex = 0;
  let selectedDistance = Number.POSITIVE_INFINITY;

  todos.forEach((todo, index) => {
    const distance = Math.abs(getTodoTimelineTime(todo) - now);
    if (distance < selectedDistance) {
      selectedIndex = index;
      selectedDistance = distance;
    }
  });

  return selectedIndex;
}

function mapEsp32TodoItem(todo: TodoListItem): Esp32TodoItem {
  return {
    id: todo.id,
    title: todo.title,
    description: todo.description || '',
    status: 'pending',
    priority: todo.priority,
    due_at: todo.due_at,
    reminder_at: todo.reminder_at,
    timeline_at: getTodoTimelineAt(todo),
    subject_name: todo.subject_name,
    updated_at: todo.updated_at,
  };
}

export async function loadEsp32TodoTimeline(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: {
    limit?: number;
    cursor?: string | null;
    server_time?: string | null;
  } = {}
): Promise<Esp32TodoTimeline> {
  const limit = limitWithin(input.limit, 1, 24);
  const serverTime =
    parseOptionalTimestamp(input.server_time) || new Date().toISOString();

  const { data, error } = await supabase
    .from('todos')
    .select(TODO_SELECT_COLUMNS)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .is('archived_at', null)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(ESP32_TIMELINE_MAX_ROWS);

  if (error) throw new TodoToolError('database_error', error.message, 500);

  const allTodos = (data || []).map(mapTodoRow).sort(compareTodoTimeline);
  const total = allTodos.length;
  const maxStart = Math.max(total - limit, 0);
  const closestIndex = findClosestTodoIndex(allTodos, serverTime);
  const cursor = parseTodoCursor(input.cursor);
  const defaultStart =
    closestIndex >= 0 ? closestIndex - Math.floor(limit / 2) : 0;
  const start = Math.min(Math.max(cursor?.offset ?? defaultStart, 0), maxStart);
  const windowTodos = allTodos.slice(start, start + limit);

  let selectedIndex = -1;
  if (windowTodos.length > 0) {
    if (cursor?.selected === 'last') {
      selectedIndex = windowTodos.length - 1;
    } else if (cursor?.selected === 'first') {
      selectedIndex = 0;
    } else {
      selectedIndex = Math.min(
        Math.max(closestIndex - start, 0),
        windowTodos.length - 1
      );
    }
  }

  const hasEarlier = start > 0;
  const hasLater = start + windowTodos.length < total;

  return {
    scope: 'timeline',
    todos: windowTodos.map(mapEsp32TodoItem),
    selected_index: selectedIndex,
    selected_todo_id:
      selectedIndex >= 0 ? (windowTodos[selectedIndex]?.id ?? null) : null,
    previous_cursor: hasEarlier
      ? encodeTodoCursor(Math.max(start - limit, 0), 'last')
      : null,
    next_cursor: hasLater
      ? encodeTodoCursor(Math.min(start + limit, maxStart), 'first')
      : null,
    has_earlier: hasEarlier,
    has_later: hasLater,
    has_more: hasLater,
    total,
    server_time: serverTime,
  };
}

export async function completeTodoFromDevice(
  ctx: TodoToolContext,
  input: { todo_id: string }
): Promise<{ todo: TodoListItem; action: TodoStatusUpdatedAction }> {
  const todo = await completeTodo(ctx.supabase, ctx.userId, input.todo_id);
  return {
    todo,
    action: {
      type: 'todo_status_updated',
      todo_id: todo.id,
      title: todo.title,
      status: todo.status,
    },
  };
}

export async function listTodosForAi(
  ctx: TodoToolContext,
  input: { status?: TodoStatus | 'all'; limit?: number } = {}
) {
  const todos = await loadTodos(ctx.supabase, ctx.userId, {
    status: input.status || 'pending',
    limit: limitWithin(input.limit, 1, 8),
  });

  return {
    todos: todos.map(todo => ({
      id: todo.id,
      title: todo.title,
      description: todo.description || '',
      status: todo.status,
      priority: todo.priority,
      due_at: todo.due_at,
      reminder_at: todo.reminder_at,
      subject_name: todo.subject_name,
    })),
  };
}

export async function createTodoFromAi(
  ctx: TodoToolContext,
  input: {
    title: string;
    description?: string | null;
    priority?: TodoPriority;
    due_at?: string | null;
    reminder_at?: string | null;
    subject_id?: string | null;
    problem_id?: string | null;
    notebook_id?: string | null;
  }
): Promise<{ todo: TodoListItem; action: TodoCreatedAction }> {
  const todo = await createTodo(ctx.supabase, ctx.userId, {
    ...input,
    source: 'ai',
    created_by: 'ai',
    source_conversation_id: ctx.conversationId || null,
    source_device_id: ctx.deviceId || null,
  });

  return {
    todo,
    action: {
      type: 'todo_created',
      todo_id: todo.id,
      title: todo.title,
      status: 'pending',
      due_at: todo.due_at,
      reminder_at: todo.reminder_at,
    },
  };
}

export async function updateTodoStatusFromAi(
  ctx: TodoToolContext,
  input: { todo_id: string; status: TodoStatus }
): Promise<{ todo: TodoListItem; action: TodoStatusUpdatedAction }> {
  const todo = await updateTodoStatus(
    ctx.supabase,
    ctx.userId,
    input.todo_id,
    input.status
  );

  return {
    todo,
    action: {
      type: 'todo_status_updated',
      todo_id: todo.id,
      title: todo.title,
      status: todo.status,
    },
  };
}

export function todoErrorResponse(error: unknown) {
  if (error instanceof TodoToolError) {
    return Response.json(
      createApiErrorResponse(error.message, error.status, { code: error.code }),
      { status: error.status }
    );
  }
  return Response.json(createApiErrorResponse('Todo request failed', 500), {
    status: 500,
  });
}

export function todoSuccessResponse<T>(data: T, status = 200) {
  return Response.json(createApiSuccessResponse(data), { status });
}

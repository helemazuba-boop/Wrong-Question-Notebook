import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';

export type NotebookShelfItemType = 'problem_set' | 'notebook' | 'word_deck';

export interface NotebookShelfItem {
  id: string;
  type: NotebookShelfItemType;
  title: string;
  subject_id: string;
  subject_name: string;
  description: string | null;
  count: number;
  updated_at: string | null;
  metadata?: {
    source?: string;
    language?: string;
    target_language?: string;
    lexicon_type?: string;
    is_system?: boolean;
  };
  ai_access?: {
    can_read: boolean;
    can_create: boolean;
    can_update: boolean;
  };
}

export interface NotebookAiAction {
  type: 'notebook_note_created';
  notebook_id: string;
  note_id: string;
  title: string;
}

export interface NotebookToolContext {
  userId: string;
  supabase: SupabaseClient<Database>;
  conversationId?: string | null;
}

export class NotebookToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'NotebookToolError';
  }
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length > 0) {
    const count = (value[0] as { count?: unknown }).count;
    return typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }
  return 0;
}

export async function loadNotebookShelf(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<NotebookShelfItem[]> {
  const [problemSetsResult, notebooksResult, wordDecksResult] =
    await Promise.all([
      supabase
        .from('problem_sets')
        .select(
          'id, name, description, subject_id, updated_at, subjects(name), problem_set_problems(count)'
        )
        .eq('user_id', userId),
      supabase
        .from('notebooks')
        .select(
          'id, title, description, subject_id, updated_at, subjects(name), notebook_notes(count), notebook_ai_access(can_read, can_create, can_update)'
        )
        .eq('user_id', userId)
        .is('archived_at', null),
      (supabase as SupabaseClient<any>)
        .from('word_decks')
        .select(
          'id, title, description, source, subject_id, subjects(name), language, target_language, lexicon_type, is_system, updated_at, word_entries(count)'
        )
        .is('archived_at', null)
        .eq('is_active', true)
        .or(`user_id.eq.${userId},is_system.eq.true`),
    ]);

  if (problemSetsResult.error) {
    throw new NotebookToolError(
      'database_error',
      problemSetsResult.error.message,
      500
    );
  }
  if (notebooksResult.error) {
    throw new NotebookToolError(
      'database_error',
      notebooksResult.error.message,
      500
    );
  }
  if (wordDecksResult.error) {
    throw new NotebookToolError(
      'database_error',
      wordDecksResult.error.message,
      500
    );
  }

  const problemSets = (problemSetsResult.data || []).map((item: any) => ({
    id: item.id,
    type: 'problem_set' as const,
    title: item.name,
    subject_id: item.subject_id,
    subject_name: item.subjects?.name || '',
    description: item.description,
    count: normalizeCount(item.problem_set_problems),
    updated_at: item.updated_at,
  }));

  const notebooks = (notebooksResult.data || []).map((item: any) => {
    const access = Array.isArray(item.notebook_ai_access)
      ? item.notebook_ai_access[0]
      : null;
    return {
      id: item.id,
      type: 'notebook' as const,
      title: item.title,
      subject_id: item.subject_id,
      subject_name: item.subjects?.name || '',
      description: item.description,
      count: normalizeCount(item.notebook_notes),
      updated_at: item.updated_at,
      ai_access: {
        can_read: Boolean(access?.can_read),
        can_create: Boolean(access?.can_create),
        can_update: Boolean(access?.can_update),
      },
    };
  });

  const wordDecks = (wordDecksResult.data || []).map((item: any) => ({
    id: item.id,
    type: 'word_deck' as const,
    title: item.title,
    subject_id: item.subject_id || '',
    subject_name: item.subjects?.name || '',
    description: item.description,
    count: normalizeCount(item.word_entries),
    updated_at: item.updated_at,
    metadata: {
      source: item.source || 'user',
      language: item.language || 'en',
      target_language: item.target_language || 'zh-CN',
      lexicon_type: item.lexicon_type || 'english_word',
      is_system: Boolean(item.is_system),
    },
  }));

  return [...problemSets, ...notebooks, ...wordDecks].sort((a, b) => {
    const left = a.updated_at ? Date.parse(a.updated_at) : 0;
    const right = b.updated_at ? Date.parse(b.updated_at) : 0;
    return right - left;
  });
}

export async function verifySubjectOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('subjects')
    .select('id')
    .eq('id', subjectId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data)
    throw new NotebookToolError('subject_not_found', 'Subject not found', 404);
}

export async function createNotebook(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: {
    subject_id: string;
    title: string;
    description?: string | null;
    color?: string | null;
    icon?: string | null;
  }
) {
  await verifySubjectOwner(supabase, userId, input.subject_id);
  const { data, error } = await supabase
    .from('notebooks')
    .insert({
      user_id: userId,
      subject_id: input.subject_id,
      title: input.title,
      description: input.description || null,
      color: input.color || null,
      icon: input.icon || null,
    })
    .select()
    .single();

  if (error) throw new NotebookToolError('database_error', error.message, 500);
  return data;
}

export async function upsertNotebookAiAccess(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string,
  access: { can_read: boolean; can_create: boolean; can_update: boolean }
) {
  await verifyNotebookOwner(supabase, userId, notebookId);
  const { data, error } = await supabase
    .from('notebook_ai_access')
    .upsert(
      {
        user_id: userId,
        notebook_id: notebookId,
        can_read: access.can_read,
        can_create: access.can_create,
        can_update: access.can_update,
      },
      { onConflict: 'user_id,notebook_id' }
    )
    .select()
    .single();

  if (error) throw new NotebookToolError('database_error', error.message, 500);
  return data;
}

export async function verifyNotebookOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('notebooks')
    .select('id')
    .eq('id', notebookId)
    .eq('user_id', userId)
    .is('archived_at', null)
    .maybeSingle();

  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data)
    throw new NotebookToolError(
      'notebook_not_found',
      'Notebook not found',
      404
    );
}

async function loadNotebookAiAccess(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string
): Promise<{
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
} | null> {
  const { data, error } = await supabase
    .from('notebook_ai_access')
    .select('can_read, can_create, can_update')
    .eq('user_id', userId)
    .eq('notebook_id', notebookId)
    .maybeSingle();

  if (error) throw new NotebookToolError('database_error', error.message, 500);
  return data;
}

export async function listAuthorizedNotebooks(ctx: NotebookToolContext) {
  const { data, error } = await ctx.supabase
    .from('notebook_ai_access')
    .select(
      'can_read, can_create, can_update, notebooks(id, title, description, subject_id, subjects(name), notebook_notes(count))'
    )
    .eq('user_id', ctx.userId)
    .or('can_read.eq.true,can_create.eq.true,can_update.eq.true');

  if (error) throw new NotebookToolError('database_error', error.message, 500);

  return {
    notebooks: (data || [])
      .map((row: any) => {
        const notebook = row.notebooks;
        if (!notebook) return null;
        return {
          id: notebook.id,
          title: notebook.title,
          subject_name: notebook.subjects?.name || '',
          description: notebook.description || '',
          permissions: {
            can_read: Boolean(row.can_read),
            can_create: Boolean(row.can_create),
            can_update: Boolean(row.can_update),
          },
          note_count: normalizeCount(notebook.notebook_notes),
        };
      })
      .filter(Boolean),
  };
}

export async function createNotebookNoteFromAi(
  ctx: NotebookToolContext,
  input: {
    notebook_id: string;
    title: string;
    content: string;
    linked_problem_id?: string | null;
    metadata?: Json;
  }
): Promise<{
  note: { id: string; notebook_id: string; title: string; created_at: string };
  action: NotebookAiAction;
}> {
  await verifyNotebookOwner(ctx.supabase, ctx.userId, input.notebook_id);
  const access = await loadNotebookAiAccess(
    ctx.supabase,
    ctx.userId,
    input.notebook_id
  );
  if (!access?.can_create) {
    throw new NotebookToolError(
      'notebook_permission_denied',
      'AI has no permission to write that notebook',
      403
    );
  }

  if (input.linked_problem_id) {
    const { data: problem, error: problemError } = await ctx.supabase
      .from('problems')
      .select('id')
      .eq('id', input.linked_problem_id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (problemError)
      throw new NotebookToolError('database_error', problemError.message, 500);
    if (!problem)
      throw new NotebookToolError(
        'problem_not_found',
        'Problem not found',
        404
      );
  }

  const metadata = {
    ...(input.metadata &&
    typeof input.metadata === 'object' &&
    !Array.isArray(input.metadata)
      ? input.metadata
      : {}),
    source_conversation_id: ctx.conversationId || null,
  } as Json;

  const { data, error } = await ctx.supabase
    .from('notebook_notes')
    .insert({
      user_id: ctx.userId,
      notebook_id: input.notebook_id,
      title: input.title.trim().slice(0, 120),
      content: input.content.trim().slice(0, 4000),
      source: 'ai',
      linked_problem_id: input.linked_problem_id || null,
      metadata,
    })
    .select('id, notebook_id, title, created_at')
    .single();

  if (error) throw new NotebookToolError('database_error', error.message, 500);

  return {
    note: data,
    action: {
      type: 'notebook_note_created',
      notebook_id: data.notebook_id,
      note_id: data.id,
      title: data.title,
    },
  };
}

export async function createNotebookNoteFromUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string,
  input: {
    title: string;
    content: string;
    linked_problem_id?: string | null;
    metadata?: Json;
  }
) {
  await verifyNotebookOwner(supabase, userId, notebookId);

  if (input.linked_problem_id) {
    const { data: problem, error: problemError } = await supabase
      .from('problems')
      .select('id')
      .eq('id', input.linked_problem_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (problemError) {
      throw new NotebookToolError('database_error', problemError.message, 500);
    }
    if (!problem) {
      throw new NotebookToolError(
        'problem_not_found',
        'Problem not found',
        404
      );
    }
  }

  const metadata =
    input.metadata && typeof input.metadata === 'object' ? input.metadata : {};

  const { data, error } = await supabase
    .from('notebook_notes')
    .insert({
      user_id: userId,
      notebook_id: notebookId,
      title: input.title.trim().slice(0, 120),
      content: input.content.trim().slice(0, 4000),
      source: 'user',
      linked_problem_id: input.linked_problem_id || null,
      metadata,
    })
    .select()
    .single();

  if (error) throw new NotebookToolError('database_error', error.message, 500);
  return data;
}

export async function searchUserProblems(
  ctx: NotebookToolContext,
  input: { query: string; subject_id?: string | null; limit?: number }
) {
  const limit = Math.min(Math.max(input.limit || 5, 1), 5);
  let query = ctx.supabase
    .from('problems')
    .select(
      'id, title, subject_id, problem_type, status, updated_at, subjects(name)'
    )
    .eq('user_id', ctx.userId)
    .limit(limit);

  if (input.subject_id) query = query.eq('subject_id', input.subject_id);
  const text = input.query.trim();
  if (text) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const searchTerm = `"%${escaped}%"`;
    query = query.or(
      `title.ilike.${searchTerm},content.ilike.${searchTerm},solution_text.ilike.${searchTerm}`
    );
  }

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) throw new NotebookToolError('database_error', error.message, 500);

  return {
    problems: (data || []).map((problem: any) => ({
      id: problem.id,
      title: problem.title,
      subject_name: problem.subjects?.name || '',
      problem_type: problem.problem_type,
      status: problem.status,
      updated_at: problem.updated_at,
    })),
  };
}

export async function getProblemDetail(
  ctx: NotebookToolContext,
  input: { problem_id: string }
) {
  const { data, error } = await ctx.supabase
    .from('problems')
    .select(
      'id, title, content, solution_text, correct_answer, status, problem_type, subjects(name)'
    )
    .eq('id', input.problem_id)
    .eq('user_id', ctx.userId)
    .maybeSingle();

  if (error) throw new NotebookToolError('database_error', error.message, 500);
  if (!data)
    throw new NotebookToolError('problem_not_found', 'Problem not found', 404);

  return {
    problem: {
      id: data.id,
      title: data.title,
      subject_name: (data as any).subjects?.name || '',
      content_text: data.content || '',
      solution_text: data.solution_text || '',
      correct_answer: data.correct_answer || '',
      status: data.status,
      problem_type: data.problem_type,
    },
  };
}

export function notebookErrorResponse(error: unknown) {
  if (error instanceof NotebookToolError) {
    return Response.json(
      createApiErrorResponse(error.message, error.status, { code: error.code }),
      { status: error.status }
    );
  }
  return Response.json(createApiErrorResponse('Notebook request failed', 500), {
    status: 500,
  });
}

export function notebookSuccessResponse<T>(data: T, status = 200) {
  return Response.json(createApiSuccessResponse(data), { status });
}

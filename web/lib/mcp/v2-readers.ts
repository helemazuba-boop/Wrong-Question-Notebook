import 'server-only';
import { FILE_CONSTANTS } from '@/lib/constants';
import { stripHtml } from '@/lib/html-sanitizer';
import { listAuthorizedNotebooks } from '@/lib/notebooks';
import { listAuthorizedWordDecks } from '@/lib/words';
import { loadWebWordStudySession } from '@/lib/word-study-web';
import { loadWebNoteStudySession } from '@/lib/note-study-web';
import {
  getFilteredProblems,
  getFilteredProblemsCount,
} from '@/lib/review-utils';
import type { FilterConfig } from '@/lib/types';
import { findMcpTool, type McpToolContext } from './tool-registry';
import { ResourceDto, type McpV2ToolName } from './v2-contracts';
import { McpV2Error, type JsonObject } from './v2-operations';

export function problemText(html: string): string {
  return stripHtml(
    html.replace(
      /<(span|div)\b[^>]*\bdata-latex="([^"]*)"[^>]*>[\s\S]*?<\/\1>/gi,
      (_match, tag: string, latex: string) =>
        `${tag === 'div' ? '$$' : '$'}${latex}${tag === 'div' ? '$$' : '$'}`
    )
  );
}
export function resource(row: JsonObject, kind: string): JsonObject {
  const summary = typeof row.summary === 'object' ? row.summary : row.reading;
  return ResourceDto.parse({
    ...row,
    id: row.id ?? row.item_id ?? row.note_id ?? row.resource_id,
    permissions: row.permissions
      ? {
          ...row.permissions,
          can_update: false,
          can_propose_updates: Boolean(row.permissions.can_read),
        }
      : undefined,
    resource_type: row.resource_type ?? kind,
    title: row.title ?? row.name ?? row.word ?? row.note_title ?? '',
    content_text:
      row.content_text ??
      (typeof row.summary === 'string' ? row.summary : undefined),
    description: row.description ?? undefined,
    summary: summary
      ? Object.fromEntries(
          Object.entries(summary).filter(([, v]) => typeof v === 'number')
        )
      : undefined,
    tags: Array.isArray(row.tags)
      ? row.tags.map((tag: any) => (typeof tag === 'string' ? tag : tag.name))
      : undefined,
    word_deck_id:
      row.word_deck_id ?? row.deck_id ?? row.relations?.word_deck_id,
    notebook_id: row.notebook_id ?? row.relations?.notebook_id,
    linked_problem_id: row.linked_problem_id ?? row.linked_problem?.problem_id,
    images: row.image_assets ?? row.images,
    read_state:
      row.read_state ??
      (row.note_id && row.state
        ? {
            state: row.state,
            last_completed_at: row.last_completed_at ?? null,
            completed_count: row.completed_count ?? 0,
          }
        : undefined),
  });
}
export function legacyArgs(args: JsonObject): JsonObject {
  const result = { ...args };
  for (const [from, to] of [
    ['word_deck_id', 'deck_id'],
    ['word_deck_ids', 'deck_ids'],
    ['word_entry_id', 'word_id'],
  ])
    if (from in result) {
      result[to] = result[from];
      delete result[from];
    }
  return result;
}
export async function requirePermission(
  ctx: McpToolContext,
  kind: 'note' | 'word',
  ids: string[],
  create = false
) {
  const allowed =
    kind === 'note'
      ? (await listAuthorizedNotebooks(ctx)).notebooks
      : (await listAuthorizedWordDecks(ctx)).decks;
  for (const id of ids)
    if (
      !allowed.some(
        row =>
          row.id === id && row.permissions[create ? 'can_create' : 'can_read']
      )
    )
      throw new McpV2Error(
        `${kind}_permission_denied`,
        '该资源未授权 AI 访问。'
      );
}
export async function session(
  ctx: McpToolContext,
  kind: 'note' | 'word',
  id: string
) {
  // Verify the complete scope before loading candidates, including replays.
  const { data, error } = await ctx.supabase
    .from('study_sessions')
    .select('scope')
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .eq('domain', kind)
    .is('device_id', null)
    .maybeSingle();
  if (error) throw new McpV2Error('session_unavailable', '会话不可用。', true);
  if (!data) throw new McpV2Error('session_not_found', '会话不存在。');
  const scope = data.scope as JsonObject;
  await requirePermission(
    ctx,
    kind,
    kind === 'note' ? scope.notebook_ids : scope.deck_ids
  );
  const view: JsonObject =
    kind === 'note'
      ? await loadWebNoteStudySession(ctx.supabase, ctx.userId, id)
      : await loadWebWordStudySession(ctx.supabase, ctx.userId, id, {
          currentOnly: true,
        });
  const current = kind === 'note' ? view.current_item : view.items[0];
  if (kind === 'note' && current) {
    const assets = current.assets ?? [];
    const { data: urls } = assets.length
      ? await ctx.supabase.storage
          .from(FILE_CONSTANTS.STORAGE.BUCKET)
          .createSignedUrls(
            assets.map((a: JsonObject) => a.display_path ?? a.path),
            3600
          )
      : { data: [] };
    current.image_assets = assets.map((a: JsonObject, i: number) => ({
      path: a.path,
      url: urls?.[i]?.signedUrl ?? null,
    }));
    current.image_count = assets.length;
  }
  return {
    session: {
      session_id: view.session_id,
      status: view.status,
      mode: view.mode,
      candidate_count: view.candidate_count,
      next_sequence: view.next_sequence,
      started_at: view.started_at,
      expires_at: view.expires_at,
      ...(kind === 'note'
        ? { notebook_ids: view.notebook_ids }
        : { word_deck_ids: view.deck_ids }),
      result: view.result,
    },
    current_item: current
      ? resource(current, kind === 'note' ? 'note' : 'word')
      : null,
  };
}
export async function problemDetail(ctx: McpToolContext, id: string) {
  const { data, error } = await ctx.supabase
    .from('problems')
    .select('*, subjects(name), problem_tag(tags:tag_id(id,name))')
    .eq('id', id)
    .eq('user_id', ctx.userId)
    .maybeSingle();
  if (error) throw new McpV2Error('database_error', '题目读取失败。', true);
  if (!data) throw new McpV2Error('problem_not_found', '题目不存在。');
  const row = data as JsonObject;
  const { data: context, error: ideaError } = await ctx.supabase
    .from('problem_user_contexts')
    .select('problem_initial_idea_revisions(idea,revision,idea_origin)')
    .eq('user_id', ctx.userId)
    .eq('problem_id', id)
    .maybeSingle();
  if (ideaError)
    throw new McpV2Error('database_error', '个人思路读取失败。', true);
  const idea = (context as any)?.problem_initial_idea_revisions;
  async function images(assets: any[]) {
    if (!assets?.length) return [];
    const { data: urls } = await ctx.supabase.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .createSignedUrls(
        assets.map(a => a.display_path ?? a.path),
        3600
      );
    return assets.map((a, i) => ({
      path: a.path,
      url: urls?.[i]?.signedUrl ?? null,
      role: a.role,
    }));
  }
  const [problemImages, solutionImages, actions] = await Promise.all([
    images(row.assets),
    images(row.solution_assets),
    (ctx.supabase as any)
      .from('mcp_v2_user_actions')
      .select('id')
      .eq('user_id', ctx.userId)
      .eq('resource_id', id)
      .eq('kind', 'images')
      .eq('state', 'pending'),
  ]);
  if (actions.error)
    throw new McpV2Error('database_error', '补图状态读取失败。', true);
  let complete = true;
  const parts = (Array.isArray(row.parts) ? row.parts : []).map(
    (part: JsonObject) => {
      const choices = part.mcq_choices ?? part.answer_config?.choices ?? null;
      if (
        ['single_choice', 'multi_choice'].includes(part.type) &&
        !choices?.length
      )
        complete = false;
      return {
        index: part.index,
        type: part.type,
        label: part.label ?? null,
        full_marks: part.full_marks ?? null,
        content_html: part.content ?? '',
        content_text: problemText(part.content ?? ''),
        correct_answer: part.correct_answer ?? null,
        mcq_choices: choices,
        answer_config: part.answer_config ?? null,
      };
    }
  );
  return {
    item: resource(
      {
        ...row,
        subject_name: row.subjects?.name ?? '',
        content_html: row.content,
        content_text: problemText(row.content ?? ''),
        solution_html: row.solution_text,
        solution_text: problemText(row.solution_text ?? ''),
        parts,
        structure_complete: complete,
        problem_images: problemImages,
        solution_images: solutionImages,
        image_completion_required: actions.data?.length > 0,
        initial_idea: idea?.idea ?? null,
        initial_idea_revision: idea?.revision ?? 0,
        exam_source: Object.fromEntries(
          ['year', 'paper', 'question_no', 'exam_type']
            .filter(k => row.source?.[k] != null)
            .map(k => [k, row.source[k]])
        ),
        evidence: {
          answer_origin: row.source?.answer_origin ?? null,
          solution_origin: row.source?.solution_origin ?? null,
          initial_idea_origin: idea?.idea_origin ?? null,
        },
        extraction_warnings: row.source?.confidence?.warnings ?? [],
        tags: row.problem_tag?.map((x: any) => x.tags?.name).filter(Boolean),
        tag_ids: row.problem_tag?.map((x: any) => x.tags?.id).filter(Boolean),
        web_url: new URL(
          `/subjects/${row.subject_id}/problems/${id}/review`,
          ctx.origin
        ).toString(),
      },
      'problem'
    ),
  };
}
function page(items: JsonObject[], raw: JsonObject = {}) {
  return {
    items,
    next_cursor: raw.next_cursor ?? null,
    has_more: Boolean(raw.has_more),
    total: raw.total ?? raw.count ?? null,
  };
}
export function projectLegacy(name: string, raw: JsonObject) {
  if (raw.session) {
    const view = raw.session;
    const kind = name.includes('note') ? 'note' : 'word';
    const current =
      view.current_item ?? view.items?.[view.next_sequence] ?? null;
    const data = {
      session: {
        session_id: view.session_id,
        status: view.status,
        mode: view.mode,
        candidate_count: view.candidate_count,
        next_sequence: view.next_sequence,
        started_at: view.started_at,
        expires_at: view.expires_at,
        ...(kind === 'note'
          ? { notebook_ids: view.notebook_ids }
          : { word_deck_ids: view.deck_ids }),
        result: view.result ?? {},
      },
      current_item: current ? resource(current, kind) : null,
    };
    if (raw.observation) return { observation: raw.observation, ...data };
    return data;
  }
  if (raw.review) return { observation: raw.review };
  for (const [key, kind] of [
    ['problem', 'problem'],
    ['note', 'note'],
    ['todo', 'todo'],
    ['entry', 'word'],
    ['deck', 'word_deck'],
    ['word', 'word'],
  ])
    if (raw[key] && !Array.isArray(raw[key]))
      return { item: resource(raw[key], kind) };
  if (name === 'get_learning_overview')
    return {
      generated_at: raw.generated_at,
      problems: raw.problems.due.map((x: JsonObject) => resource(x, 'problem')),
      notebooks: raw.notes.notebooks.map((x: JsonObject) =>
        resource(x, 'notebook')
      ),
      recent_notes: raw.notes.recent.map((x: JsonObject) =>
        resource(x, 'note')
      ),
      word_decks: raw.words.decks.map((x: JsonObject) =>
        resource(x, 'word_deck')
      ),
      todos: (Array.isArray(raw.todos)
        ? raw.todos
        : (raw.todos.todos ?? [])
      ).map((x: JsonObject) => resource(x, 'todo')),
    };
  if (name === 'get_note_reading_overview')
    return {
      notebooks: raw.notebooks.map((x: JsonObject) => resource(x, 'notebook')),
      recent_notes: raw.recent.map((x: JsonObject) => resource(x, 'note')),
    };
  for (const [key, kind] of [
    ['problems', 'problem'],
    ['notes', 'note'],
    ['notebooks', 'notebook'],
    ['words', 'word'],
    ['entries', 'word'],
    ['decks', 'word_deck'],
    ['todos', 'todo'],
    ['problem_sets', 'problem_set'],
    ['results', 'problem'],
  ])
    if (Array.isArray(raw[key]))
      return page(
        raw[key].map((x: JsonObject) => resource(x, kind)),
        raw
      );
  throw new McpV2Error('output_contract_error', '工具结果不符合 v2 契约。');
}
const filterOf = (set: JsonObject): FilterConfig => ({
  tag_ids: set.filter_config?.tag_ids ?? [],
  statuses: set.filter_config?.statuses ?? [],
  problem_types: set.filter_config?.problem_types ?? [],
  days_since_review: set.filter_config?.days_since_review ?? null,
  include_never_reviewed: set.filter_config?.include_never_reviewed ?? true,
});
export async function readV2(
  ctx: McpToolContext,
  name: McpV2ToolName,
  args: JsonObject
) {
  if (name === 'get_problem_detail') return problemDetail(ctx, args.problem_id);
  if (name === 'get_word_detail') {
    const { data, error } = await ctx.supabase
      .from('word_entries')
      .select(
        '*,word_decks(user_id,is_system,is_active,archived_at),word_progress(status,due_at,reviewed_count,known_count,unknown_count,user_id)'
      )
      .eq('id', args.word_entry_id)
      .eq('word_progress.user_id', ctx.userId)
      .maybeSingle();
    const row = data as JsonObject | null;
    const deck = row?.word_decks;
    if (error) throw new McpV2Error('database_error', '词条读取失败。', true);
    if (
      !row ||
      !deck ||
      (!deck.is_system && deck.user_id !== ctx.userId) ||
      !deck.is_active ||
      deck.archived_at
    )
      throw new McpV2Error('word_not_found', '词条不存在。');
    await requirePermission(ctx, 'word', [row.deck_id]);
    const progress = Array.isArray(row.word_progress)
      ? row.word_progress[0]
      : row.word_progress;
    return {
      item: resource(
        {
          ...row,
          progress: progress ?? {
            status: 'new',
            due_at: null,
            reviewed_count: 0,
            known_count: 0,
            unknown_count: 0,
          },
        },
        'word'
      ),
    };
  }
  if (name === 'get_word_study_session' || name === 'get_note_reading_session')
    return session(
      ctx,
      name.includes('note') ? 'note' : 'word',
      args.session_id
    );
  if (name === 'get_todo') {
    const { data, error } = await ctx.supabase
      .from('todos')
      .select('*')
      .eq('id', args.todo_id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (error || !data) throw new McpV2Error('todo_not_found', 'Todo 不存在。');
    return { item: resource(data, 'todo') };
  }
  if (name === 'list_problem_sets') {
    const offset = Number(args.cursor ?? 0),
      limit = args.limit ?? 20;
    let query = ctx.supabase
      .from('problem_sets')
      .select('*,subjects(name),problem_set_problems(count)', {
        count: 'exact',
      })
      .eq('user_id', ctx.userId);
    if (args.subject_id) query = query.eq('subject_id', args.subject_id);
    const { data, error, count } = await query
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new McpV2Error('database_error', '错题集读取失败。', true);
    const items = await Promise.all(
      (data ?? []).map(async (set: any) =>
        resource(
          {
            ...set,
            subject_name: set.subjects?.name ?? '',
            problem_count: set.is_smart
              ? await getFilteredProblemsCount(
                  ctx.supabase,
                  ctx.userId,
                  set.subject_id,
                  filterOf(set)
                )
              : Number(set.problem_set_problems?.[0]?.count ?? 0),
          },
          'problem_set'
        )
      )
    );
    return page(items, {
      total: count ?? 0,
      has_more: offset + items.length < (count ?? 0),
      next_cursor:
        offset + items.length < (count ?? 0)
          ? String(offset + items.length)
          : null,
    });
  }
  if (name === 'list_problem_set_problems') {
    const { data: set, error } = await ctx.supabase
      .from('problem_sets')
      .select('*')
      .eq('id', args.problem_set_id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (error || !set)
      throw new McpV2Error('problem_set_not_found', '错题集不存在。');
    if (set.is_smart) {
      const offset = Number(args.cursor ?? 0),
        limit = args.limit ?? 20;
      const [rows, total] = await Promise.all([
        getFilteredProblems(
          ctx.supabase,
          ctx.userId,
          set.subject_id,
          filterOf(set),
          undefined,
          { offset, limit }
        ),
        getFilteredProblemsCount(
          ctx.supabase,
          ctx.userId,
          set.subject_id,
          filterOf(set)
        ),
      ]);
      return page(
        rows.map(x => resource(x, 'problem')),
        {
          total,
          has_more: offset + rows.length < total,
          next_cursor:
            offset + rows.length < total ? String(offset + rows.length) : null,
        }
      );
    }
  }
  const renamed = legacyArgs(args);
  if (['search_words', 'search_user_problems'].includes(name)) {
    renamed.q = args.query;
    delete renamed.query;
  }
  const raw = (await findMcpTool(name)!.handler(ctx, renamed)) as JsonObject;
  if (name === 'search_words' || name === 'list_word_mistakes') {
    const decks = (await listAuthorizedWordDecks(ctx)).decks
      .filter(x => x.permissions.can_read)
      .map(x => x.id);
    if (args.word_deck_id && !decks.includes(args.word_deck_id))
      throw new McpV2Error('word_permission_denied', '词库未授权。');
    raw.words = raw.words.filter((x: JsonObject) =>
      decks.includes(x.deck_id ?? x.word_deck_id)
    );
  }
  return projectLegacy(name, raw);
}

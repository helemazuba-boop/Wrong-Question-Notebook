// MCP tool registry: the single tool table served by /api/mcp and consumed by
// the ESP32 voice chains -- lib/ai-tools/voice-tools.ts projects the shared
// catalog entries (tool-catalog.ts) into OpenAI function definitions, and the
// voice adapter executes these same handlers.
//
// Every handler returns the full JSON payload; the external AI client needs
// the data itself, while the voice adapter maps that payload to a short
// display string plus a device action. Handlers reuse the same lib functions
// and permission gates as the web/voice paths. Note that many handlers here
// and in tool-extensions.ts query tables directly through the service-role
// client with an explicit user_id filter -- a new handler must scope its own
// reads and writes the same way.

import { randomBytes } from 'crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { FILE_CONSTANTS } from '@/lib/constants';
import {
  createNotebookNoteFromAi,
  listAuthorizedNotebooks,
  loadNotebookAiAccess,
  searchUserProblems,
  NotebookToolError,
} from '@/lib/notebooks';
import { getNote, listNotes } from '@/lib/notebook-content-service';
import {
  createTodoFromAi,
  loadTodos,
  updateTodoStatusFromAi,
  type TodoPriority,
  type TodoStatus,
} from '@/lib/todos';
import { recordProblemReview } from '@/lib/problem-review-service';
import type { ProblemObservationRequest } from '@/lib/problem-study-v1';
import {
  createWordDeck,
  listAuthorizedWordDecks,
  loadWrongWords,
  searchWords,
  type WordLexiconType,
} from '@/lib/words';
import {
  loadWebWordStudySession,
  loadWordDeckStudySummaries,
} from '@/lib/word-study-web';
import { MCP_TOOL_EXTENSIONS } from '@/lib/mcp/tool-extensions';
import { TOOL_CATALOG, type ToolCatalogEntry } from '@/lib/mcp/tool-catalog';

// Shared execution context for every registry consumer. The external MCP
// endpoint fills the credential fields; the ESP32 voice tools fill the
// conversation/device provenance fields. Handlers must not assume both are
// present -- the initial-idea chain guards its own credential requirements.
export interface McpToolContext {
  userId: string;
  supabase: SupabaseClient<Database>;
  /** MCP credential row id (PAT or OAuth token). Absent on voice calls. */
  apiTokenId?: string;
  /** App origin used to build user-facing confirmation links. MCP only. */
  origin?: string;
  confirmationPath?: string;
  /** Voice conversation/device provenance for AI-created rows. */
  conversationId?: string | null;
  deviceId?: string | null;
}

export interface McpToolDefinition extends ToolCatalogEntry {
  // Zod twin of inputSchema, enforced by the route before the handler runs.
  // Keep both in sync when a tool's contract changes.
  argsSchema: z.ZodType;
  handler: (
    ctx: McpToolContext,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}

// Row ids are Supabase UUIDs; a bounded URL-safe charset covers them while
// rejecting injection-shaped payloads.
const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a URL-safe id');
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

// 1 hour: matches the exposure window the web viewer's signPaths accepts.
const SIGNED_URL_EXPIRES_IN = 3600;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;
const IDEMPOTENT_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;
const NON_IDEMPOTENT_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

async function requireNotebookAiRead(
  ctx: McpToolContext,
  notebookId: string
): Promise<void> {
  const access = await loadNotebookAiAccess(
    ctx.supabase,
    ctx.userId,
    notebookId
  );
  if (!access?.can_read) {
    throw new NotebookToolError(
      'notebook_permission_denied',
      'AI has no permission to read that notebook',
      403
    );
  }
}

// Best-effort signed URLs for problem images. A storage hiccup degrades to
// path-only entries instead of failing the whole detail read.
async function signAssetUrls(
  ctx: McpToolContext,
  assets: unknown
): Promise<Array<{ path: string; url: string | null }>> {
  if (!Array.isArray(assets) || assets.length === 0) return [];
  const paths = assets
    .map(asset =>
      typeof asset === 'object' && asset !== null
        ? str((asset as any).display_path) || str((asset as any).path)
        : ''
    )
    .filter(Boolean);
  if (paths.length === 0) return [];
  const { data, error } = await ctx.supabase.storage
    .from(FILE_CONSTANTS.STORAGE.BUCKET)
    .createSignedUrls(paths, SIGNED_URL_EXPIRES_IN);
  if (error || !data) {
    return paths.map(path => ({ path, url: null }));
  }
  return data.map((entry: any, i: number) => ({
    path: paths[i],
    url: (entry?.signedUrl as string) ?? null,
  }));
}

export const MCP_TOOLS: McpToolDefinition[] = [
  // -- Word domain ------------------------------------------------------------
  {
    name: 'list_word_progress',
    description:
      '读取当前用户的 Word 词库进度汇总。Web、MCP 与 WQN Note4 使用同一份 word_progress，适合先查看到期词和掌握数量。',
    inputSchema: {
      type: 'object',
      properties: {
        deck_id: { type: 'string', description: '可选词库 ID' },
      },
    },
    argsSchema: z.object({ deck_id: IdSchema.nullish() }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const requestedDeckId = optStr(args.deck_id);
      const authorized = await listAuthorizedWordDecks(ctx);
      const visibleDecks = requestedDeckId
        ? authorized.decks.filter(
            deck => deck.id === requestedDeckId && deck.permissions.can_read
          )
        : authorized.decks.filter(deck => deck.permissions.can_read);
      if (requestedDeckId && visibleDecks.length === 0) {
        throw new NotebookToolError(
          'word_deck_permission_denied',
          'AI has no permission to read that Word deck',
          404
        );
      }
      const summaries = await loadWordDeckStudySummaries(
        ctx.supabase,
        ctx.userId,
        visibleDecks.map(deck => deck.id)
      );
      return {
        decks: visibleDecks.map(deck => ({
          id: deck.id,
          title: deck.title,
          subject_id: deck.subject_id,
          permissions: deck.permissions,
          summary: summaries[deck.id],
        })),
      };
    },
  },
  {
    name: 'list_word_mistakes',
    description:
      '列出 Word 学习中投影出的错题词条。每条记录都可以继续进入对应的错题集复习。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量，1-50，默认 20' },
      },
    },
    argsSchema: z.object({
      limit: z.number().int().min(1).max(50).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) =>
      loadWrongWords(ctx.supabase, ctx.userId, {
        limit: optNum(args.limit) ?? 20,
      }),
  },
  {
    name: 'get_word_study_session',
    description:
      '读取一个 Web Word 学习会话的当前游标、词条快照和已确认结果统计，用于跨端恢复或向用户解释进度。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Web 学习会话 ID' },
      },
      required: ['session_id'],
    },
    argsSchema: z.object({ session_id: IdSchema }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => ({
      session: await loadWebWordStudySession(
        ctx.supabase,
        ctx.userId,
        str(args.session_id)
      ),
    }),
  },

  {
    ...TOOL_CATALOG.create_word_deck,
    argsSchema: z.object({
      title: z.string().trim().min(1).max(80),
      description: z.string().max(500).nullish(),
      subject_id: IdSchema.nullish(),
      language: z.string().trim().max(16).nullish(),
      target_language: z.string().trim().max(16).nullish(),
      lexicon_type: z
        .enum(['english_word', 'classical_chinese_term'])
        .nullish(),
    }),
    annotations: NON_IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const result = await createWordDeck(ctx.supabase, ctx.userId, {
        title: str(args.title),
        description: optStr(args.description) ?? null,
        subject_id: optStr(args.subject_id) ?? null,
        language: optStr(args.language) ?? undefined,
        target_language: optStr(args.target_language) ?? undefined,
        lexicon_type: optStr(args.lexicon_type) as WordLexiconType | undefined,
        source: 'ai',
      });
      return { deck: result.deck, action: result.action };
    },
  },
  {
    ...TOOL_CATALOG.search_words,
    argsSchema: z.object({
      q: z.string().trim().max(80).nullish(),
      prefix: z.string().trim().max(80).nullish(),
      deck_id: IdSchema.nullish(),
      limit: z.number().int().min(1).max(20).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) =>
      searchWords(ctx.supabase, ctx.userId, {
        q: optStr(args.q) ?? undefined,
        prefix: optStr(args.prefix) ?? undefined,
        deck_id: optStr(args.deck_id) ?? undefined,
        limit: optNum(args.limit) ?? 10,
      }),
  },

  // -- Problem domain (review offloading core) -------------------------------
  {
    name: 'list_review_due_problems',
    description:
      '列出当前用户已到期待复习的错题（按复习计划 next_review_at 升序）。这是错题复习的入口：先调它拿到待复习列表，再用 get_problem_detail 逐题读取。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量，1-20，默认 10' },
      },
    },
    argsSchema: z.object({
      limit: z.number().int().min(1).max(20).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const limit = Math.min(Math.max(optNum(args.limit) ?? 10, 1), 20);
      const { data, error } = await ctx.supabase
        .from('review_schedule')
        .select(
          'next_review_at, interval_days, repetition_number, problems(id, title, status, subject_id, subjects(name))'
        )
        .eq('user_id', ctx.userId)
        .lte('next_review_at', new Date().toISOString())
        .order('next_review_at', { ascending: true })
        .limit(limit);
      if (error) {
        throw new NotebookToolError('database_error', error.message, 500);
      }
      return {
        problems: (data ?? [])
          .map((row: any) => {
            const problem = row.problems;
            if (!problem) return null;
            return {
              id: problem.id,
              title: problem.title,
              status: problem.status,
              subject_name: problem.subjects?.name || '',
              next_review_at: row.next_review_at,
              interval_days: row.interval_days,
              repetition_number: row.repetition_number,
            };
          })
          .filter(Boolean),
      };
    },
  },
  {
    ...TOOL_CATALOG.search_user_problems,
    argsSchema: z.object({
      query: z.string().min(1).max(200),
      subject_id: IdSchema.nullish(),
      limit: z.number().int().min(1).max(5).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) =>
      searchUserProblems(ctx, {
        query: str(args.query),
        subject_id: optStr(args.subject_id),
        limit: optNum(args.limit),
      }),
  },
  {
    ...TOOL_CATALOG.get_problem_detail,
    argsSchema: z.object({
      problem_id: IdSchema,
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const problemId = str(args.problem_id);
      const { data, error } = await ctx.supabase
        .from('problems')
        .select(
          'id, title, content, solution_text, parts, status, assets, solution_assets, subjects(name)'
        )
        .eq('id', problemId)
        .eq('user_id', ctx.userId)
        .maybeSingle();
      if (error) {
        throw new NotebookToolError('database_error', error.message, 500);
      }
      if (!data) {
        throw new NotebookToolError(
          'problem_not_found',
          'Problem not found',
          404
        );
      }
      const [problemImages, solutionImages] = await Promise.all([
        signAssetUrls(ctx, data.assets),
        signAssetUrls(ctx, data.solution_assets),
      ]);
      return {
        problem: {
          id: data.id,
          title: data.title,
          subject_name: (data as any).subjects?.name || '',
          content_text: data.content || '',
          solution_text: data.solution_text || '',
          status: data.status,
          // Gaokao shell model: the real statements live per part; the
          // shell-level content is often empty.
          parts: Array.isArray(data.parts)
            ? (data.parts as any[]).map(part => ({
                index: part?.index,
                label: part?.label || '',
                type: part?.type,
                full_marks: part?.full_marks ?? null,
                content_text: part?.content || '',
                correct_answer: part?.correct_answer || '',
              }))
            : [],
          problem_images: problemImages,
          solution_images: solutionImages,
        },
      };
    },
  },
  {
    name: 'record_problem_review',
    description:
      '提交一次错题复习自评并推进复习计划（与设备端同一条 SM-2 管道）。action：correct=已掌握 / hesitant=还要想想 / wrong=错了重来 / skip=跳过（不影响状态与计划）。每道题复习结束后必须调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        problem_id: { type: 'string', description: '错题 ID' },
        action: {
          type: 'string',
          enum: ['correct', 'hesitant', 'wrong', 'skip'],
          description: '自评结果',
        },
        request_id: {
          type: 'string',
          description:
            '可选幂等 ID（16-64 位 URL-safe 字符）；重试时带同一个值',
        },
      },
      required: ['problem_id', 'action'],
    },
    argsSchema: z.object({
      problem_id: IdSchema,
      action: z.enum(['correct', 'hesitant', 'wrong', 'skip']),
      request_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,64}$/, 'must be 16-64 URL-safe characters')
        .nullish(),
    }),
    annotations: NON_IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      // ProblemObservationRequest is the device-protocol shape; only
      // request_id/problem_id/action/occurred_at reach the RPC. The metadata
      // fields are device telemetry with no MCP equivalent, so they carry
      // fixed placeholders purely to satisfy the shared type.
      const request: ProblemObservationRequest = {
        request_id: optStr(args.request_id) ?? randomBytes(16).toString('hex'),
        boot_id: 'mcp-stateless',
        firmware_version: 'mcp-1.0.0',
        capabilities: ['problem.review.mcp'],
        problem_id: str(args.problem_id),
        action: str(args.action) as ProblemObservationRequest['action'],
        occurred_at: new Date().toISOString(),
      };
      const result = await recordProblemReview(
        ctx.supabase,
        ctx.userId,
        null,
        request
      );
      return { review: result };
    },
  },

  // -- Notebook domain --------------------------------------------------------
  {
    ...TOOL_CATALOG.list_authorized_notebooks,
    argsSchema: z.object({}),
    handler: async ctx => listAuthorizedNotebooks(ctx),
  },
  {
    name: 'list_notes',
    description:
      '列出某个已授权（can_read）笔记本中的笔记、阅读状态和正文摘要；全文用 get_note 读取。支持关键词过滤与游标分页。',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string', description: '笔记本 ID' },
        query: { type: 'string', description: '可选标题/正文关键词' },
        cursor: {
          type: 'string',
          description: '可选分页游标（上次返回的 next_cursor）',
        },
        limit: { type: 'number', description: '返回数量，1-100，默认 20' },
      },
      required: ['notebook_id'],
    },
    argsSchema: z.object({
      notebook_id: IdSchema,
      query: z.string().max(200).nullish(),
      cursor: z.string().min(1).max(512).nullish(),
      limit: z.number().int().min(1).max(100).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const notebookId = str(args.notebook_id);
      await requireNotebookAiRead(ctx, notebookId);
      const result = await listNotes(ctx.supabase, ctx.userId, notebookId, {
        query: optStr(args.query) ?? null,
        cursor: optStr(args.cursor) ?? null,
        limit: optNum(args.limit),
      });
      return {
        notes: result.notes.map(note => ({
          id: note.id,
          title: note.title,
          summary:
            note.content.length > 200
              ? `${note.content.slice(0, 200)}…`
              : note.content,
          image_count: note.assets.length,
          read_state: note.read_state || {
            state: 'unread',
            last_opened_at: null,
            last_completed_at: null,
            completed_count: 0,
          },
          updated_at: note.updated_at,
        })),
        next_cursor: result.next_cursor,
        has_more: result.has_more,
      };
    },
  },
  {
    name: 'get_note',
    description:
      '读取某条笔记的全文、revision 与共享阅读状态（纯文本，最多 4000 字符）。需要该笔记本的 can_read 授权；更新时把 revision 传给 expected_revision。',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string', description: '笔记本 ID' },
        note_id: { type: 'string', description: '笔记 ID' },
      },
      required: ['notebook_id', 'note_id'],
    },
    argsSchema: z.object({
      notebook_id: IdSchema,
      note_id: IdSchema,
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const notebookId = str(args.notebook_id);
      await requireNotebookAiRead(ctx, notebookId);
      const note = await getNote(
        ctx.supabase,
        ctx.userId,
        notebookId,
        str(args.note_id)
      );
      return {
        note: {
          id: note.id,
          notebook_id: note.notebook_id,
          revision: note.revision,
          title: note.title,
          content: note.content,
          linked_problem_id: note.linked_problem_id,
          read_state: note.read_state || {
            state: 'unread',
            last_opened_at: null,
            last_completed_at: null,
            completed_count: 0,
          },
          image_count: note.assets.length,
          image_assets: await signAssetUrls(ctx, note.assets),
          created_at: note.created_at,
          updated_at: note.updated_at,
        },
      };
    },
  },
  {
    ...TOOL_CATALOG.create_notebook_note,
    argsSchema: z.object({
      notebook_id: IdSchema,
      title: z.string().min(1).max(120),
      content: z.string().min(1).max(4000),
      linked_problem_id: IdSchema.nullish(),
      client_request_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,128}$/, 'must be 8-128 URL-safe characters')
        .nullish(),
    }),
    annotations: NON_IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const result = await createNotebookNoteFromAi(ctx, {
        notebook_id: str(args.notebook_id),
        title: str(args.title),
        content: str(args.content),
        linked_problem_id: optStr(args.linked_problem_id) ?? null,
        client_request_id: optStr(args.client_request_id) ?? null,
      });
      return { note: result.note, action: result.action };
    },
  },

  // -- Todo domain ------------------------------------------------------------
  {
    ...TOOL_CATALOG.list_todos,
    argsSchema: z.object({
      status: z.enum(['pending', 'completed', 'cancelled', 'all']).nullish(),
      subject_id: IdSchema.nullish(),
      limit: z.number().int().min(1).max(50).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const todos = await loadTodos(ctx.supabase, ctx.userId, {
        status: (optStr(args.status) as TodoStatus | 'all') || 'pending',
        subject_id: optStr(args.subject_id) ?? null,
        limit: optNum(args.limit) ?? 20,
      });
      return { todos };
    },
  },
  {
    ...TOOL_CATALOG.create_todo,
    argsSchema: z.object({
      title: z.string().min(1).max(120),
      description: z.string().max(2000).nullish(),
      priority: z.enum(['low', 'normal', 'high']).nullish(),
      due_at: IsoDateTimeSchema.nullish(),
      reminder_at: IsoDateTimeSchema.nullish(),
      subject_id: IdSchema.nullish(),
      problem_set_id: IdSchema.nullish(),
      problem_id: IdSchema.nullish(),
      notebook_id: IdSchema.nullish(),
      note_id: IdSchema.nullish(),
      word_deck_id: IdSchema.nullish(),
      word_entry_id: IdSchema.nullish(),
    }),
    annotations: NON_IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const result = await createTodoFromAi(ctx, {
        title: str(args.title),
        description: optStr(args.description) ?? null,
        priority: optStr(args.priority) as TodoPriority | undefined,
        due_at: optStr(args.due_at) ?? null,
        reminder_at: optStr(args.reminder_at) ?? null,
        subject_id: optStr(args.subject_id) ?? null,
        problem_set_id: optStr(args.problem_set_id) ?? null,
        problem_id: optStr(args.problem_id) ?? null,
        notebook_id: optStr(args.notebook_id) ?? null,
        note_id: optStr(args.note_id) ?? null,
        word_deck_id: optStr(args.word_deck_id) ?? null,
        word_entry_id: optStr(args.word_entry_id) ?? null,
      });
      return { todo: result.todo, action: result.action };
    },
  },
  {
    ...TOOL_CATALOG.update_todo_status,
    argsSchema: z.object({
      todo_id: IdSchema,
      status: z.enum(['pending', 'completed', 'cancelled']),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const result = await updateTodoStatusFromAi(ctx, {
        todo_id: str(args.todo_id),
        status: str(args.status) as TodoStatus,
      });
      return { todo: result.todo, action: result.action };
    },
  },
  ...MCP_TOOL_EXTENSIONS,
];

export function findMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find(tool => tool.name === name);
}

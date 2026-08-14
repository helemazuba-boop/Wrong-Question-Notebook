import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type {
  McpToolContext,
  McpToolDefinition,
} from '@/lib/mcp/tool-registry';
import {
  listAuthorizedNotebooks,
  loadNotebookAiAccess,
  NotebookToolError,
} from '@/lib/notebooks';
import { updateNote } from '@/lib/notebook-content-service';
import {
  createNoteStudySession,
  recordNoteStudyObservation,
  skipNoteStudyObservation,
} from '@/lib/note-study-service';
import {
  loadNotebookReadSummaries,
  loadRecentNoteReads,
  loadWebNoteStudySession,
  setWebNoteStudySessionStatus,
} from '@/lib/note-study-web';
import {
  addWordEntryToDeck,
  getWordDetail,
  listAuthorizedWordDecks,
  listWordEntriesForDeck,
  updateWordEntry,
  WordToolError,
} from '@/lib/words';
import {
  createWordStudySession,
  recordWordStudyObservation,
  skipWordStudyObservation,
} from '@/lib/word-study-service';
import {
  loadWebWordStudySession,
  loadWordProgressOverview,
  setWebWordStudySessionStatus,
} from '@/lib/word-study-web';
import {
  getTodoById,
  loadTodos,
  updateTodo,
  type TodoPriority,
} from '@/lib/todos';
import {
  createProblem,
  createProblemFromImages,
  ProblemCreationServiceError,
  type CreateProblemInput,
} from '@/lib/problem-creation-service';
import {
  PROBLEM_EXTRACTION_JSON_SCHEMA,
  PROBLEM_EXTRACTION_MIME_TYPES,
  PROBLEM_EXTRACTION_SYSTEM_PROMPT,
} from '@/lib/problem-extraction-service';
import { ProblemExtractionSchema } from '@/lib/problem-extraction';
import { ProblemInitialIdeaSchema } from '@/lib/schemas';
import type { NoteObservationAction, NoteStudyMode } from '@/lib/note-study-v1';
import type { WordObservationAction, WordStudyMode } from '@/lib/word-study-v1';

const UuidSchema = z.uuid();
const RequestIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const CursorSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .max(12)
  .refine(value => Number(value) <= 10_000, 'cursor is too large');
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const MAX_BASE64_IMAGE_CHARS = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 4;
const MCP_IDEA_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CreateProblemToolArgsSchema = z.union([
  z.object({ get_prompt: z.literal(true) }),
  ProblemExtractionSchema.extend({
    get_prompt: z.literal(false).optional(),
    title: z.string().trim().min(1).max(200),
    request_id: RequestIdSchema,
    subject_id: UuidSchema.nullish(),
    problem_set_id: UuidSchema.nullish(),
    initial_idea_draft: ProblemInitialIdeaSchema.optional(),
  }),
]);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function base64UrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function mcpIdeaConfirmUrl(
  ctx: McpToolContext,
  challengeId: string,
  challengeToken: string
): string {
  const path = `${ctx.confirmationPath}/${challengeId}`;
  const url = new URL(path, ctx.origin);
  url.hash = `token=${challengeToken}`;
  return url.toString();
}

async function createMcpInitialIdeaChallenge(
  ctx: McpToolContext,
  problemId: string,
  requestId: string,
  proposedIdea: string
) {
  const exactTextHash = sha256Hex(proposedIdea);
  const existing = await ctx.supabase
    .from('problem_initial_idea_mcp_challenges')
    .select(
      'id, problem_id, source_api_token_id, proposed_idea, exact_text_hash, expires_at, consumed_at'
    )
    .eq('user_id', ctx.userId)
    .eq('source_request_id', requestId)
    .maybeSingle();

  if (existing.error) {
    throw new ProblemCreationServiceError(
      'initial_idea_challenge_failed',
      existing.error.message,
      500,
      true
    );
  }

  if (existing.data) {
    const sameRequest =
      existing.data.problem_id === problemId &&
      existing.data.source_api_token_id === ctx.apiTokenId &&
      existing.data.proposed_idea === proposedIdea &&
      existing.data.exact_text_hash === exactTextHash;
    if (!sameRequest) {
      throw new ProblemCreationServiceError(
        'request_id_reused',
        'request_id was already used with different initial idea input',
        409
      );
    }
    if (existing.data.consumed_at) {
      throw new ProblemCreationServiceError(
        'initial_idea_challenge_consumed',
        'The initial idea confirmation challenge was already consumed',
        409
      );
    }
  }

  // Issue a fresh plaintext token for an identical retry and replace only its
  // digest. The token is never persisted or logged; old confirmation links are
  // invalidated. This also repairs an expired or response-lost first call.
  const challengeToken = base64UrlToken();
  const expiresAt = new Date(
    Date.now() + MCP_IDEA_CHALLENGE_TTL_MS
  ).toISOString();
  const challengeTokenHash = sha256Hex(challengeToken);
  let challengeId: string;

  if (existing.data) {
    const updated = await ctx.supabase
      .from('problem_initial_idea_mcp_challenges')
      .update({
        challenge_token_hash: challengeTokenHash,
        expires_at: expiresAt,
      })
      .eq('id', existing.data.id)
      .eq('user_id', ctx.userId)
      .is('consumed_at', null)
      .select('id')
      .single();
    if (updated.error || !updated.data) {
      throw new ProblemCreationServiceError(
        'initial_idea_challenge_failed',
        updated.error?.message ?? 'Failed to refresh confirmation challenge',
        500,
        true
      );
    }
    challengeId = updated.data.id;
  } else {
    const inserted = await ctx.supabase
      .from('problem_initial_idea_mcp_challenges')
      .insert({
        user_id: ctx.userId,
        problem_id: problemId,
        source_api_token_id: ctx.apiTokenId,
        source_request_id: requestId,
        proposed_idea: proposedIdea,
        exact_text_hash: exactTextHash,
        challenge_token_hash: challengeTokenHash,
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (inserted.error || !inserted.data) {
      throw new ProblemCreationServiceError(
        'initial_idea_challenge_failed',
        inserted.error?.message ?? 'Failed to create confirmation challenge',
        500,
        true
      );
    }
    challengeId = inserted.data.id;
  }

  return {
    status: 'confirmation_required' as const,
    exact_text: proposedIdea,
    exact_text_hash: exactTextHash,
    expires_at: expiresAt,
    confirm_url: mcpIdeaConfirmUrl(ctx, challengeId, challengeToken),
    next_step:
      'Stop. Show exact_text verbatim to the user and ask them to open confirm_url. Do not call another tool to attest or confirm on their behalf. Only the signed-in WQN page can promote this machine draft to human evidence.',
  };
}

function offsetFromCursor(value: unknown): number {
  const parsed = Number.parseInt(str(value) || '0', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nextOffsetCursor(
  offset: number,
  pageLength: number,
  total: number
): string | null {
  const next = offset + pageLength;
  return next < total ? String(next) : null;
}

function literalSearchTerm(value: string): string {
  const escaped = value.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"%${escaped}%"`;
}

async function requireNotebookPermission(
  ctx: McpToolContext,
  notebookId: string,
  permission: 'can_read' | 'can_create' | 'can_update'
) {
  const access = await loadNotebookAiAccess(
    ctx.supabase,
    ctx.userId,
    notebookId
  );
  if (!access?.[permission]) {
    throw new NotebookToolError(
      'notebook_permission_denied',
      `AI does not have ${permission} permission for that notebook`,
      403
    );
  }
}

async function loadWordDeckPermission(
  ctx: McpToolContext,
  deckId: string
): Promise<{
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
}> {
  const { data, error } = await ctx.supabase
    .from('word_deck_ai_access')
    .select('can_read, can_create, can_update')
    .eq('user_id', ctx.userId)
    .eq('deck_id', deckId)
    .maybeSingle();
  if (error) throw new WordToolError('database_error', error.message, 500);
  if (!data) {
    throw new WordToolError(
      'word_deck_permission_denied',
      'AI has no permission for that Word deck',
      403
    );
  }
  return data;
}

async function requireWordDeckPermission(
  ctx: McpToolContext,
  deckId: string,
  permission: 'can_read' | 'can_create' | 'can_update'
) {
  const access = await loadWordDeckPermission(ctx, deckId);
  if (!access[permission]) {
    throw new WordToolError(
      'word_deck_permission_denied',
      `AI does not have ${permission} permission for that Word deck`,
      403
    );
  }
}

async function requireWordEntryPermission(
  ctx: McpToolContext,
  wordId: string,
  permission: 'can_read' | 'can_update'
): Promise<string> {
  const { data, error } = await ctx.supabase
    .from('word_entries')
    .select('deck_id')
    .eq('id', wordId)
    .maybeSingle();
  if (error) throw new WordToolError('database_error', error.message, 500);
  if (!data) throw new WordToolError('word_not_found', 'Word not found', 404);
  await requireWordDeckPermission(ctx, data.deck_id, permission);
  return data.deck_id;
}

async function requireNoteSessionPermissions(
  ctx: McpToolContext,
  sessionId: string
) {
  const session = await loadWebNoteStudySession(
    ctx.supabase,
    ctx.userId,
    sessionId
  );
  await Promise.all(
    session.notebook_ids.map(notebookId =>
      requireNotebookPermission(ctx, notebookId, 'can_read')
    )
  );
  return session;
}

async function requireWordSessionPermissions(
  ctx: McpToolContext,
  sessionId: string
) {
  const session = await loadWebWordStudySession(
    ctx.supabase,
    ctx.userId,
    sessionId
  );
  await Promise.all(
    session.deck_ids.map(deckId =>
      requireWordDeckPermission(ctx, deckId, 'can_read')
    )
  );
  return session;
}

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

const COMMON_TOOLS: McpToolDefinition[] = [
  {
    name: 'get_learning_overview',
    description:
      '读取今天的统一学习概览：到期错题、授权 Word 词库进度、授权 Note 阅读进度与待办 Todo。适合作为一次学习对话的第一个调用。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '每类最多返回数量，1-20，默认 8',
        },
      },
    },
    argsSchema: z.object({
      limit: z.number().int().min(1).max(20).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const limit = optionalNumber(args.limit) ?? 8;
      const [notebookAccess, wordAccess, dueRows, todos] = await Promise.all([
        listAuthorizedNotebooks(ctx),
        listAuthorizedWordDecks(ctx),
        ctx.supabase
          .from('review_schedule')
          .select(
            'next_review_at, interval_days, repetition_number, problems(id, title, status, subject_id, subjects(name))'
          )
          .eq('user_id', ctx.userId)
          .lte('next_review_at', new Date().toISOString())
          .order('next_review_at', { ascending: true })
          .limit(limit),
        loadTodos(ctx.supabase, ctx.userId, {
          status: 'pending',
          limit,
        }),
      ]);
      if (dueRows.error) {
        throw new NotebookToolError(
          'database_error',
          dueRows.error.message,
          500
        );
      }
      const readableNotebooks = notebookAccess.notebooks.filter(
        notebook => notebook.permissions.can_read
      );
      const readableDecks = wordAccess.decks.filter(
        deck => deck.permissions.can_read
      );
      const [noteSummaries, recentNotes, wordProgress] = await Promise.all([
        loadNotebookReadSummaries(
          ctx.supabase,
          ctx.userId,
          readableNotebooks.map(notebook => notebook.id)
        ),
        loadRecentNoteReads(ctx.supabase, ctx.userId, { limit }),
        loadWordProgressOverview(
          ctx.supabase,
          ctx.userId,
          readableDecks.map(deck => deck.id)
        ),
      ]);
      return {
        generated_at: new Date().toISOString(),
        problems: {
          due: (dueRows.data ?? []).flatMap((row: any) =>
            row.problems
              ? [
                  {
                    id: row.problems.id,
                    title: row.problems.title,
                    status: row.problems.status,
                    subject_id: row.problems.subject_id,
                    subject_name: row.problems.subjects?.name || '',
                    next_review_at: row.next_review_at,
                    interval_days: row.interval_days,
                    repetition_number: row.repetition_number,
                  },
                ]
              : []
          ),
        },
        notes: {
          notebooks: readableNotebooks.map(notebook => ({
            ...notebook,
            reading: noteSummaries[notebook.id],
          })),
          recent: recentNotes.filter(note =>
            readableNotebooks.some(notebook => notebook.id === note.notebook_id)
          ),
        },
        words: {
          decks: readableDecks,
          progress: wordProgress,
        },
        todos,
      };
    },
  },
  {
    name: 'search_learning_content',
    description:
      '跨 Problem、Note、Word、Todo 搜索当前用户内容。科目只是可选过滤条件；Note/Word 只搜索已授权给 AI 读取的容器。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['problem', 'note', 'word', 'todo'],
          },
          description: '可选资源类型；省略表示全部',
        },
        subject_id: { type: 'string', description: '可选科目 ID' },
        cursor: { type: 'string', description: '可选数字游标' },
        limit: { type: 'number', description: '总返回数量，1-40，默认 20' },
      },
      required: ['query'],
    },
    argsSchema: z.object({
      query: z.string().trim().min(1).max(200),
      types: z
        .array(z.enum(['problem', 'note', 'word', 'todo']))
        .min(1)
        .max(4)
        .nullish(),
      subject_id: UuidSchema.nullish(),
      cursor: CursorSchema.nullish(),
      limit: z.number().int().min(1).max(40).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const queryText = str(args.query).trim();
      const types = new Set(
        (args.types as string[] | null | undefined) ?? [
          'problem',
          'note',
          'word',
          'todo',
        ]
      );
      const subjectId = optionalString(args.subject_id);
      const offset = offsetFromCursor(args.cursor);
      const limit = optionalNumber(args.limit) ?? 20;
      const fetchLimit = offset + limit + 1;
      const [notebookAccess, wordAccess] = await Promise.all([
        types.has('note')
          ? listAuthorizedNotebooks(ctx)
          : Promise.resolve({ notebooks: [] }),
        types.has('word')
          ? listAuthorizedWordDecks(ctx)
          : Promise.resolve({ decks: [] }),
      ]);
      const readableNotebooks = notebookAccess.notebooks.filter(
        notebook =>
          notebook.permissions.can_read &&
          (!subjectId || notebook.subject_id === subjectId)
      );
      const readableDecks = wordAccess.decks.filter(
        deck =>
          deck.permissions.can_read &&
          (!subjectId || deck.subject_id === subjectId)
      );
      const searchTerm = literalSearchTerm(queryText);
      const searchProblems = async () => {
        if (!types.has('problem')) {
          return { data: [], error: null };
        }
        let query = ctx.supabase
          .from('problems')
          .select('id, title, subject_id, updated_at')
          .eq('user_id', ctx.userId)
          .or(
            `title.ilike.${searchTerm},content.ilike.${searchTerm},solution_text.ilike.${searchTerm}`
          );
        if (subjectId) query = query.eq('subject_id', subjectId);
        return query
          .order('updated_at', { ascending: false })
          .limit(fetchLimit);
      };
      const searchTodos = async () => {
        if (!types.has('todo')) {
          return { data: [], error: null };
        }
        let query = ctx.supabase
          .from('todos')
          .select(
            'id, title, description, status, subject_id, problem_id, note_id, word_entry_id, updated_at'
          )
          .eq('user_id', ctx.userId)
          .is('archived_at', null)
          .or(`title.ilike.${searchTerm},description.ilike.${searchTerm}`);
        if (subjectId) query = query.eq('subject_id', subjectId);
        return query
          .order('updated_at', { ascending: false })
          .limit(fetchLimit);
      };
      const [problemResult, noteResult, wordResult, todoResult] =
        await Promise.all([
          searchProblems(),
          types.has('note') && readableNotebooks.length
            ? ctx.supabase
                .from('notebook_notes')
                .select(
                  'id, notebook_id, title, content, updated_at, notebooks(title, subject_id)'
                )
                .eq('user_id', ctx.userId)
                .in(
                  'notebook_id',
                  readableNotebooks.map(notebook => notebook.id)
                )
                .is('archived_at', null)
                .or(`title.ilike.${searchTerm},content.ilike.${searchTerm}`)
                .order('updated_at', { ascending: false })
                .limit(fetchLimit)
            : Promise.resolve({ data: [], error: null }),
          types.has('word') && readableDecks.length
            ? ctx.supabase
                .from('word_entries')
                .select(
                  'id, deck_id, word, meaning, updated_at, word_decks(title, subject_id)'
                )
                .in(
                  'deck_id',
                  readableDecks.map(deck => deck.id)
                )
                .or(`word.ilike.${searchTerm},meaning.ilike.${searchTerm}`)
                .order('updated_at', { ascending: false })
                .limit(fetchLimit)
            : Promise.resolve({ data: [], error: null }),
          searchTodos(),
        ]);
      for (const result of [
        problemResult,
        noteResult,
        wordResult,
        todoResult,
      ]) {
        if (result.error) {
          throw new NotebookToolError(
            'database_error',
            result.error.message,
            500
          );
        }
      }
      const merged = [
        ...(problemResult.data ?? []).map((problem: any) => ({
          resource_type: 'problem',
          resource_id: problem.id,
          title: problem.title,
          summary: '',
          subject_id: problem.subject_id ?? null,
          updated_at: problem.updated_at,
          relations: {},
        })),
        ...(noteResult.data ?? []).map((note: any) => ({
          resource_type: 'note',
          resource_id: note.id,
          title: note.title,
          summary:
            String(note.content || '').length > 240
              ? `${String(note.content).slice(0, 240)}…`
              : String(note.content || ''),
          subject_id: note.notebooks?.subject_id || null,
          updated_at: note.updated_at,
          relations: {
            notebook_id: note.notebook_id,
            notebook_title: note.notebooks?.title || '',
          },
        })),
        ...(wordResult.data ?? []).map((word: any) => ({
          resource_type: 'word',
          resource_id: word.id,
          title: word.word,
          summary: word.meaning,
          subject_id: word.word_decks?.subject_id || null,
          updated_at: word.updated_at,
          relations: {
            word_deck_id: word.deck_id,
            word_deck_title: word.word_decks?.title || '',
          },
        })),
        ...(todoResult.data ?? []).map((todo: any) => ({
          resource_type: 'todo',
          resource_id: todo.id,
          title: todo.title,
          summary: todo.description || '',
          subject_id: todo.subject_id,
          updated_at: todo.updated_at,
          relations: {
            problem_id: todo.problem_id,
            note_id: todo.note_id,
            word_entry_id: todo.word_entry_id,
          },
        })),
      ].sort(
        (left, right) =>
          Date.parse(right.updated_at) - Date.parse(left.updated_at)
      );
      const results = merged.slice(offset, offset + limit);
      const hasMore = merged.length > offset + limit;
      return {
        results,
        next_cursor: hasMore ? String(offset + results.length) : null,
        has_more: hasMore,
      };
    },
  },
];

const PROBLEM_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_problem_sets',
    description:
      '列出当前用户自己的错题集及题目数量。支持可选科目过滤；科目为空时返回全部。',
    inputSchema: {
      type: 'object',
      properties: {
        subject_id: { type: 'string', description: '可选科目 ID' },
        cursor: { type: 'string', description: '可选数字游标' },
        limit: { type: 'number', description: '返回数量，1-50，默认 20' },
      },
    },
    argsSchema: z.object({
      subject_id: UuidSchema.nullish(),
      cursor: CursorSchema.nullish(),
      limit: z.number().int().min(1).max(50).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const offset = offsetFromCursor(args.cursor);
      const limit = optionalNumber(args.limit) ?? 20;
      let query = ctx.supabase
        .from('problem_sets')
        .select(
          'id, name, description, subject_id, is_smart, sharing_level, updated_at, subjects(name), problem_set_problems(count)',
          { count: 'exact' }
        )
        .eq('user_id', ctx.userId);
      if (args.subject_id) query = query.eq('subject_id', str(args.subject_id));
      const { data, error, count } = await query
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) {
        throw new NotebookToolError('database_error', error.message, 500);
      }
      const total = Number(count || 0);
      return {
        problem_sets: (data || []).map((set: any) => ({
          id: set.id,
          name: set.name,
          description: set.description || '',
          subject_id: set.subject_id,
          subject_name: set.subjects?.name || '',
          is_smart: Boolean(set.is_smart),
          sharing_level: set.sharing_level,
          problem_count: Number(set.problem_set_problems?.[0]?.count || 0),
          updated_at: set.updated_at,
        })),
        next_cursor: nextOffsetCursor(offset, data?.length || 0, total),
        has_more: offset + (data?.length || 0) < total,
        total,
      };
    },
  },
  {
    name: 'list_problem_set_problems',
    description:
      '分页列出当前用户某个错题集中的题目；读取完整题面后再调用 get_problem_detail。',
    inputSchema: {
      type: 'object',
      properties: {
        problem_set_id: { type: 'string', description: '错题集 ID' },
        cursor: { type: 'string', description: '可选数字游标' },
        limit: { type: 'number', description: '返回数量，1-50，默认 20' },
      },
      required: ['problem_set_id'],
    },
    argsSchema: z.object({
      problem_set_id: UuidSchema,
      cursor: CursorSchema.nullish(),
      limit: z.number().int().min(1).max(50).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const setId = str(args.problem_set_id);
      const { data: set, error: setError } = await ctx.supabase
        .from('problem_sets')
        .select('id, name, subject_id, subjects(name)')
        .eq('id', setId)
        .eq('user_id', ctx.userId)
        .maybeSingle();
      if (setError) {
        throw new NotebookToolError('database_error', setError.message, 500);
      }
      if (!set) {
        throw new NotebookToolError(
          'problem_set_not_found',
          'Problem set not found',
          404
        );
      }
      const offset = offsetFromCursor(args.cursor);
      const limit = optionalNumber(args.limit) ?? 20;
      const { data, error, count } = await ctx.supabase
        .from('problem_set_problems')
        .select(
          'problem_id, added_at, problems(id, title, status, parts, updated_at)',
          { count: 'exact' }
        )
        .eq('problem_set_id', setId)
        .order('added_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) {
        throw new NotebookToolError('database_error', error.message, 500);
      }
      const total = Number(count || 0);
      return {
        problem_set: {
          id: set.id,
          name: set.name,
          subject_id: set.subject_id,
          subject_name: (set as any).subjects?.name || '',
        },
        problems: (data || []).flatMap((row: any) =>
          row.problems
            ? [
                {
                  id: row.problems.id,
                  title: row.problems.title,
                  status: row.problems.status,
                  part_types: Array.isArray(row.problems.parts)
                    ? [
                        ...new Set(
                          row.problems.parts.map((part: any) => part?.type)
                        ),
                      ]
                    : [],
                  added_at: row.added_at,
                  updated_at: row.problems.updated_at,
                },
              ]
            : []
        ),
        next_cursor: nextOffsetCursor(offset, data?.length || 0, total),
        has_more: offset + (data?.length || 0) < total,
        total,
      };
    },
  },
  {
    name: 'create_problem',
    description:
      '两阶段新增错题：先只传 get_prompt=true 获取完整题目识别 Prompt；调用方按 Prompt 阅读图片或文本后，再省略 get_prompt（或传 false）并提交壳题干、1-10 个 typed parts、可见答案提示、标签和置信度。本工具不会再次调用 AI 或消耗识别额度；创建可选科目和目标错题集，并按 request_id 幂等。',
    inputSchema: {
      type: 'object',
      properties: {
        get_prompt: {
          type: 'boolean',
          description:
            '设为 true 时只返回完整识别 Prompt，不创建错题；创建时省略或设为 false',
        },
        request_id: {
          type: 'string',
          description: '16-64 位 URL-safe 幂等 ID；重试必须复用',
        },
        ...PROBLEM_EXTRACTION_JSON_SCHEMA.properties,
        title: {
          ...PROBLEM_EXTRACTION_JSON_SCHEMA.properties.title,
          minLength: 1,
          description: '题目主题摘要；不含题号和数学公式',
        },
        subject_id: { type: 'string', description: '可选科目 ID' },
        problem_set_id: { type: 'string', description: '可选目标错题集 ID' },
        initial_idea_draft: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description:
            '可选机器草稿。不会随建题直接写入个人原话；创建后返回逐字确认链接，只有已登录用户在 WQN 页面确认后才成为 human evidence。',
        },
      },
      oneOf: [
        {
          properties: { get_prompt: { const: true } },
          required: ['get_prompt'],
        },
        {
          properties: { get_prompt: { const: false } },
          required: ['request_id', 'title', 'parts'],
        },
      ],
    },
    argsSchema: CreateProblemToolArgsSchema,
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      if (args.get_prompt === true) {
        return {
          prompt: PROBLEM_EXTRACTION_SYSTEM_PROMPT,
          next_step:
            'Apply this prompt to the source material, then call create_problem again with get_prompt=false, a 16-64 character URL-safe request_id, and the resulting structured fields. Reuse the same request_id for retries.',
        };
      }
      const extraction = ProblemExtractionSchema.parse(args);
      const result = await createProblem(ctx.supabase, ctx.userId, {
        request_id: str(args.request_id),
        ...extraction,
        subject_id: optionalString(args.subject_id) ?? null,
        problem_set_id: optionalString(args.problem_set_id) ?? null,
      } satisfies CreateProblemInput);
      const initialIdeaDraft = optionalString(args.initial_idea_draft);
      if (!initialIdeaDraft) return result;

      const idea_confirmation = await createMcpInitialIdeaChallenge(
        ctx,
        result.problem.id,
        str(args.request_id),
        initialIdeaDraft
      );
      return { ...result, idea_confirmation };
    },
  },
  {
    name: 'create_problem_from_images',
    description:
      '使用现有智能识别链路从 1-4 张试卷、练习或手写图片中抽取并新增错题。不会求解；可选科目，省略时自动归入“未分类”；可选直接加入一个已有错题集。写入按 request_id 幂等。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: '16-64 位 URL-safe 幂等 ID；重试必须复用',
        },
        images: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              data: {
                type: 'string',
                description: '不带 data URL 前缀的 base64 图片数据',
              },
              mime_type: {
                type: 'string',
                enum: [...PROBLEM_EXTRACTION_MIME_TYPES],
              },
            },
            required: ['data', 'mime_type'],
          },
        },
        subject_id: { type: 'string', description: '可选科目 ID' },
        problem_set_id: { type: 'string', description: '可选目标错题集 ID' },
        initial_idea_draft: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description:
            '可选机器草稿。不会随建题直接写入个人原话；创建后返回逐字确认链接，只有已登录用户在 WQN 页面确认后才成为 human evidence。',
        },
        save_source_images: {
          type: 'boolean',
          description:
            '是否保存原图；省略时仅在识别判定图表不可文本化时保存；关键图像不可文本化时不能设为 false',
        },
      },
      required: ['request_id', 'images'],
    },
    argsSchema: z.object({
      request_id: RequestIdSchema,
      images: z
        .array(
          z.object({
            data: z.string().min(1).max(MAX_BASE64_IMAGE_CHARS),
            mime_type: z.enum(PROBLEM_EXTRACTION_MIME_TYPES),
          })
        )
        .min(1)
        .max(4),
      subject_id: UuidSchema.nullish(),
      problem_set_id: UuidSchema.nullish(),
      initial_idea_draft: ProblemInitialIdeaSchema.optional(),
      save_source_images: z.boolean().nullish(),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const result = await createProblemFromImages(ctx.supabase, ctx.userId, {
        request_id: str(args.request_id),
        images: args.images as Array<{
          data: string;
          mime_type: (typeof PROBLEM_EXTRACTION_MIME_TYPES)[number];
        }>,
        subject_id: optionalString(args.subject_id) ?? null,
        problem_set_id: optionalString(args.problem_set_id) ?? null,
        ...(typeof args.save_source_images === 'boolean'
          ? { save_source_images: args.save_source_images }
          : {}),
      });
      const initialIdeaDraft = optionalString(args.initial_idea_draft);
      if (!initialIdeaDraft) return result;

      const idea_confirmation = await createMcpInitialIdeaChallenge(
        ctx,
        result.problem.id,
        str(args.request_id),
        initialIdeaDraft
      );
      return { ...result, idea_confirmation };
    },
  },
];

const NOTE_TOOLS: McpToolDefinition[] = [
  {
    name: 'update_notebook_note',
    description:
      '更新一个已授权 can_update 的 Note。使用 expected_revision 防止覆盖用户或其他客户端刚完成的编辑；仅修改传入字段。',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string', description: '笔记本 ID' },
        note_id: { type: 'string', description: 'Note ID' },
        expected_revision: {
          type: 'number',
          description: 'get_note 返回的当前 revision',
        },
        title: { type: 'string', description: '可选新标题' },
        content: { type: 'string', description: '可选新正文' },
        linked_problem_id: {
          type: ['string', 'null'],
          description: '可选关联错题；null 表示解除关联',
        },
      },
      required: ['notebook_id', 'note_id', 'expected_revision'],
    },
    argsSchema: z
      .object({
        notebook_id: UuidSchema,
        note_id: UuidSchema,
        expected_revision: z.number().int().min(1),
        title: z.string().trim().min(1).max(120).optional(),
        content: z.string().max(4000).optional(),
        linked_problem_id: UuidSchema.nullable().optional(),
      })
      .refine(
        value =>
          value.title !== undefined ||
          value.content !== undefined ||
          value.linked_problem_id !== undefined,
        { message: 'At least one note field must be supplied' }
      ),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const notebookId = str(args.notebook_id);
      await requireNotebookPermission(ctx, notebookId, 'can_update');
      const note = await updateNote(
        ctx.supabase,
        ctx.userId,
        notebookId,
        str(args.note_id),
        {
          expected_revision: Number(args.expected_revision),
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          ...(typeof args.content === 'string'
            ? { content: args.content }
            : {}),
          ...(args.linked_problem_id !== undefined
            ? {
                linked_problem_id:
                  optionalString(args.linked_problem_id) ?? null,
              }
            : {}),
        }
      );
      return { note };
    },
  },
  {
    name: 'get_note_reading_overview',
    description:
      '读取已授权 Note 的未读/阅读中/已读数量、继续阅读位置和最近阅读记录。',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: {
          type: 'string',
          description: '可选单个笔记本 ID；省略返回全部已授权笔记本',
        },
        recent_limit: {
          type: 'number',
          description: '最近阅读数量，1-40，默认 12',
        },
      },
    },
    argsSchema: z.object({
      notebook_id: UuidSchema.nullish(),
      recent_limit: z.number().int().min(1).max(40).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const requestedId = optionalString(args.notebook_id);
      if (requestedId) {
        await requireNotebookPermission(ctx, requestedId, 'can_read');
      }
      const access = await listAuthorizedNotebooks(ctx);
      const notebooks = access.notebooks.filter(
        notebook =>
          notebook.permissions.can_read &&
          (!requestedId || notebook.id === requestedId)
      );
      if (requestedId && notebooks.length === 0) {
        throw new NotebookToolError(
          'notebook_permission_denied',
          'AI has no permission to read that notebook',
          403
        );
      }
      const [summaries, recent] = await Promise.all([
        loadNotebookReadSummaries(
          ctx.supabase,
          ctx.userId,
          notebooks.map(notebook => notebook.id)
        ),
        loadRecentNoteReads(ctx.supabase, ctx.userId, {
          ...(requestedId ? { notebook_id: requestedId } : {}),
          limit: optionalNumber(args.recent_limit) ?? 12,
        }),
      ]);
      const allowedIds = new Set(notebooks.map(notebook => notebook.id));
      return {
        notebooks: notebooks.map(notebook => ({
          ...notebook,
          reading: summaries[notebook.id],
        })),
        recent: recent.filter(item => allowedIds.has(item.notebook_id)),
      };
    },
  },
  {
    name: 'start_note_reading_session',
    description:
      '为 1-32 个已授权笔记本创建或幂等恢复一个 Note 阅读会话，返回当前 Note、阅读游标和 next_sequence。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: '16-64 位 URL-safe 幂等 ID',
        },
        notebook_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '阅读范围中的笔记本 ID',
        },
        mode: {
          type: 'string',
          enum: ['sequential', 'recent'],
          description: '顺序阅读或最近最少阅读优先',
        },
        optional_count: {
          type: 'number',
          description: '最多候选数量，1-500',
        },
        seed: { type: 'string', description: '可选稳定排序种子' },
      },
      required: ['request_id', 'notebook_ids', 'mode'],
    },
    argsSchema: z.object({
      request_id: RequestIdSchema,
      notebook_ids: z.array(UuidSchema).min(1).max(32),
      mode: z.enum(['sequential', 'recent']),
      optional_count: z.number().int().min(1).max(500).nullish(),
      seed: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/)
        .nullish(),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const notebookIds = args.notebook_ids as string[];
      await Promise.all(
        notebookIds.map(id => requireNotebookPermission(ctx, id, 'can_read'))
      );
      const created = await createNoteStudySession(
        ctx.supabase,
        ctx.userId,
        null,
        {
          request_id: str(args.request_id),
          boot_id: 'mcp-stateless',
          firmware_version: 'mcp-1.0.0',
          capabilities: ['note.study.mcp'],
          domain: 'note',
          mode: args.mode as NoteStudyMode,
          scope: {
            notebook_ids: notebookIds,
            include_archived: false,
          },
          ...(typeof args.optional_count === 'number'
            ? { optional_count: args.optional_count }
            : {}),
          ...(typeof args.seed === 'string' ? { seed: args.seed } : {}),
        }
      );
      return {
        session: await loadWebNoteStudySession(
          ctx.supabase,
          ctx.userId,
          created.session_id
        ),
      };
    },
  },
  {
    name: 'get_note_reading_session',
    description:
      '读取一个 MCP/Web Note 阅读会话的当前 Note、next_sequence、阅读统计和允许的后续动作。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Note 阅读会话 ID' },
      },
      required: ['session_id'],
    },
    argsSchema: z.object({ session_id: UuidSchema }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const session = await requireNoteSessionPermissions(
        ctx,
        str(args.session_id)
      );
      return {
        session,
        allowed_actions:
          session.status === 'active' && session.current_item
            ? ['opened', 'read_completed', 'skipped', 'paused', 'abandoned']
            : session.status === 'paused'
              ? ['active', 'abandoned']
              : [],
      };
    },
  },
  {
    name: 'record_note_reading_observation',
    description:
      '记录当前 Note 阅读项的 opened/read_completed/skipped，并推进会话 sequence。重试必须复用 request_id；不得猜测 sequence。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: '幂等 ID' },
        session_id: { type: 'string', description: '阅读会话 ID' },
        sequence: {
          type: 'number',
          description: 'get_note_reading_session 返回的 next_sequence',
        },
        note_id: { type: 'string', description: '当前 Note ID' },
        action: {
          type: 'string',
          enum: ['opened', 'read_completed', 'skipped'],
        },
        occurred_at: { type: 'string', description: '可选 ISO 时间' },
      },
      required: ['request_id', 'session_id', 'sequence', 'note_id', 'action'],
    },
    argsSchema: z.object({
      request_id: RequestIdSchema,
      session_id: UuidSchema,
      sequence: z.number().int().nonnegative(),
      note_id: UuidSchema,
      action: z.enum(['opened', 'read_completed', 'skipped']),
      occurred_at: IsoDateTimeSchema.nullish(),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const session = await requireNoteSessionPermissions(
        ctx,
        str(args.session_id)
      );
      if (
        session.next_sequence !== Number(args.sequence) ||
        session.current_item?.item_id !== str(args.note_id)
      ) {
        throw new NotebookToolError(
          'stale_note_session',
          'The Note session cursor changed; read the session again',
          409
        );
      }
      const action = args.action as NoteObservationAction;
      const request = {
        request_id: str(args.request_id),
        boot_id: 'mcp-stateless',
        firmware_version: 'mcp-1.0.0',
        capabilities: ['note.study.mcp'],
        session_id: session.session_id,
        sequence: Number(args.sequence),
        item_id: str(args.note_id),
        action,
        mode: session.mode,
        occurred_at:
          optionalString(args.occurred_at) ?? new Date().toISOString(),
      };
      const observation =
        action === 'skipped'
          ? await skipNoteStudyObservation(
              ctx.supabase,
              ctx.userId,
              null,
              request
            )
          : await recordNoteStudyObservation(
              ctx.supabase,
              ctx.userId,
              null,
              request
            );
      return {
        observation,
        session: await loadWebNoteStudySession(
          ctx.supabase,
          ctx.userId,
          session.session_id
        ),
      };
    },
  },
  {
    name: 'set_note_reading_session_status',
    description:
      '暂停、恢复、完成或结束 Note 阅读会话。completed 仅在所有候选都已确认后成立。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '阅读会话 ID' },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'completed', 'abandoned'],
        },
      },
      required: ['session_id', 'status'],
    },
    argsSchema: z.object({
      session_id: UuidSchema,
      status: z.enum(['active', 'paused', 'completed', 'abandoned']),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const session = await requireNoteSessionPermissions(
        ctx,
        str(args.session_id)
      );
      return {
        session: await setWebNoteStudySessionStatus(
          ctx.supabase,
          ctx.userId,
          session.session_id,
          args.status as 'active' | 'paused' | 'completed' | 'abandoned'
        ),
      };
    },
  },
];

const WORD_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_authorized_word_decks',
    description:
      '列出授权给 AI 的 Word 词库、词条数量和 can_read/can_create/can_update 权限。科目可能为空。',
    inputSchema: { type: 'object', properties: {} },
    argsSchema: z.object({}),
    annotations: READ_ONLY,
    handler: async ctx => listAuthorizedWordDecks(ctx),
  },
  {
    name: 'list_word_entries',
    description:
      '分页列出一个已授权 can_read 的 Word 词库中的词条、释义和个人学习进度。',
    inputSchema: {
      type: 'object',
      properties: {
        deck_id: { type: 'string', description: 'Word 词库 ID' },
        query: { type: 'string', description: '可选词形或释义关键词' },
        cursor: { type: 'string', description: '可选数字游标' },
        limit: { type: 'number', description: '返回数量，1-100，默认 20' },
      },
      required: ['deck_id'],
    },
    argsSchema: z.object({
      deck_id: UuidSchema,
      query: z.string().trim().max(80).nullish(),
      cursor: CursorSchema.nullish(),
      limit: z.number().int().min(1).max(100).nullish(),
    }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const deckId = str(args.deck_id);
      await requireWordDeckPermission(ctx, deckId, 'can_read');
      const offset = offsetFromCursor(args.cursor);
      const result = await listWordEntriesForDeck(
        ctx.supabase,
        ctx.userId,
        deckId,
        {
          q: optionalString(args.query) ?? null,
          offset,
          limit: optionalNumber(args.limit) ?? 20,
        }
      );
      return {
        entries: result.entries,
        next_cursor: nextOffsetCursor(
          offset,
          result.entries.length,
          result.count
        ),
        has_more: offset + result.entries.length < result.count,
        total: result.count,
      };
    },
  },
  {
    name: 'get_word_detail',
    description:
      '读取一个已授权 Word 词条的完整释义、例句、标签、revision 和个人学习进度。',
    inputSchema: {
      type: 'object',
      properties: {
        word_id: { type: 'string', description: 'Word 词条 ID' },
      },
      required: ['word_id'],
    },
    argsSchema: z.object({ word_id: UuidSchema }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => {
      const wordId = str(args.word_id);
      await requireWordEntryPermission(ctx, wordId, 'can_read');
      return {
        word: await getWordDetail(ctx.supabase, ctx.userId, wordId),
      };
    },
  },
  {
    name: 'add_word_entry',
    description:
      '向已授权 can_create 的用户 Word 词库新增或按规范化词形幂等更新一个词条。',
    inputSchema: {
      type: 'object',
      properties: {
        deck_id: { type: 'string', description: '目标 Word 词库 ID' },
        word: { type: 'string', description: '词形，最多 80 字符' },
        meaning: { type: 'string', description: '释义，最多 1000 字符' },
        phonetic: { type: ['string', 'null'] },
        example: { type: ['string', 'null'] },
        example_translation: { type: ['string', 'null'] },
        part_of_speech: { type: ['string', 'null'] },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '最多 16 个字符串标签',
        },
      },
      required: ['deck_id', 'word', 'meaning'],
    },
    argsSchema: z.object({
      deck_id: UuidSchema,
      word: z.string().trim().min(1).max(80),
      meaning: z.string().trim().min(1).max(1000),
      phonetic: z.string().max(120).nullable().optional(),
      example: z.string().max(1000).nullable().optional(),
      example_translation: z.string().max(1000).nullable().optional(),
      part_of_speech: z.string().max(80).nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(16).nullish(),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const deckId = str(args.deck_id);
      await requireWordDeckPermission(ctx, deckId, 'can_create');
      return addWordEntryToDeck(ctx.supabase, ctx.userId, deckId, {
        word: str(args.word),
        meaning: str(args.meaning),
        ...(args.phonetic !== undefined
          ? { phonetic: args.phonetic as string | null }
          : {}),
        ...(args.example !== undefined
          ? { example: args.example as string | null }
          : {}),
        ...(args.example_translation !== undefined
          ? {
              example_translation: args.example_translation as string | null,
            }
          : {}),
        ...(args.part_of_speech !== undefined
          ? { part_of_speech: args.part_of_speech as string | null }
          : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
        metadata: { created_by: 'mcp' },
      });
    },
  },
  {
    name: 'update_word_entry',
    description:
      '更新已授权 can_update 的 Word 词条。expected_revision 防止覆盖并发编辑；仅修改传入字段。',
    inputSchema: {
      type: 'object',
      properties: {
        word_id: { type: 'string', description: 'Word 词条 ID' },
        expected_revision: {
          type: 'number',
          description: 'get_word_detail 返回的当前 revision',
        },
        word: { type: 'string' },
        meaning: { type: 'string' },
        phonetic: { type: ['string', 'null'] },
        example: { type: ['string', 'null'] },
        example_translation: { type: ['string', 'null'] },
        part_of_speech: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['word_id', 'expected_revision'],
    },
    argsSchema: z
      .object({
        word_id: UuidSchema,
        expected_revision: z.number().int().min(1),
        word: z.string().trim().min(1).max(80).optional(),
        meaning: z.string().trim().min(1).max(1000).optional(),
        phonetic: z.string().max(120).nullable().optional(),
        example: z.string().max(1000).nullable().optional(),
        example_translation: z.string().max(1000).nullable().optional(),
        part_of_speech: z.string().max(80).nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
      })
      .refine(
        value =>
          value.word !== undefined ||
          value.meaning !== undefined ||
          value.phonetic !== undefined ||
          value.example !== undefined ||
          value.example_translation !== undefined ||
          value.part_of_speech !== undefined ||
          value.tags !== undefined,
        { message: 'At least one word field must be supplied' }
      ),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const wordId = str(args.word_id);
      await requireWordEntryPermission(ctx, wordId, 'can_update');
      return {
        word: await updateWordEntry(ctx.supabase, ctx.userId, wordId, {
          expected_revision: Number(args.expected_revision),
          ...(typeof args.word === 'string' ? { word: args.word } : {}),
          ...(typeof args.meaning === 'string'
            ? { meaning: args.meaning }
            : {}),
          ...(args.phonetic !== undefined
            ? { phonetic: args.phonetic as string | null }
            : {}),
          ...(args.example !== undefined
            ? { example: args.example as string | null }
            : {}),
          ...(args.example_translation !== undefined
            ? {
                example_translation: args.example_translation as string | null,
              }
            : {}),
          ...(args.part_of_speech !== undefined
            ? { part_of_speech: args.part_of_speech as string | null }
            : {}),
          ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
        }),
      };
    },
  },
  {
    name: 'start_word_study_session',
    description:
      '为 1-32 个已授权 can_read 的 Word 词库创建或幂等恢复学习会话，返回当前词条与 next_sequence。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: '幂等 ID' },
        deck_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '学习范围中的 Word 词库 ID',
        },
        mode: {
          type: 'string',
          enum: ['sequential', 'random', 'dictionary'],
        },
        include_mastered: {
          type: 'boolean',
          description: '随机模式是否包含已掌握词条',
        },
        optional_count: {
          type: 'number',
          description: '候选数量，1-500，默认 50',
        },
        seed: { type: 'string', description: '可选稳定排序种子' },
      },
      required: ['request_id', 'deck_ids', 'mode'],
    },
    argsSchema: z.object({
      request_id: RequestIdSchema,
      deck_ids: z.array(UuidSchema).min(1).max(32),
      mode: z.enum(['sequential', 'random', 'dictionary']),
      include_mastered: z.boolean().nullish(),
      optional_count: z.number().int().min(1).max(500).nullish(),
      seed: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/)
        .nullish(),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const deckIds = args.deck_ids as string[];
      await Promise.all(
        deckIds.map(deckId =>
          requireWordDeckPermission(ctx, deckId, 'can_read')
        )
      );
      const created = await createWordStudySession(
        ctx.supabase,
        ctx.userId,
        null,
        {
          request_id: str(args.request_id),
          boot_id: 'mcp-stateless',
          firmware_version: 'mcp-1.0.0',
          capabilities: ['word.study.mcp'],
          domain: 'word',
          mode: args.mode as WordStudyMode,
          scope: {
            deck_ids: deckIds,
            include_mastered: Boolean(args.include_mastered),
          },
          optional_count: optionalNumber(args.optional_count) ?? 50,
          ...(typeof args.seed === 'string' ? { seed: args.seed } : {}),
        }
      );
      return {
        session: await loadWebWordStudySession(
          ctx.supabase,
          ctx.userId,
          created.session_id
        ),
      };
    },
  },
  {
    name: 'record_word_study_observation',
    description:
      '提交当前 Word 学习项的 known/unknown/skipped/looked_up 并推进 sequence。重试必须复用 request_id，不得猜测 sequence。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: '幂等 ID' },
        session_id: { type: 'string', description: 'Word 学习会话 ID' },
        sequence: {
          type: 'number',
          description: 'get_word_study_session 返回的 next_sequence',
        },
        word_id: { type: 'string', description: '当前词条 ID' },
        action: {
          type: 'string',
          enum: ['known', 'unknown', 'skipped', 'looked_up'],
        },
        occurred_at: { type: 'string', description: '可选 ISO 时间' },
      },
      required: ['request_id', 'session_id', 'sequence', 'word_id', 'action'],
    },
    argsSchema: z.object({
      request_id: RequestIdSchema,
      session_id: UuidSchema,
      sequence: z.number().int().nonnegative(),
      word_id: UuidSchema,
      action: z.enum(['known', 'unknown', 'skipped', 'looked_up']),
      occurred_at: IsoDateTimeSchema.nullish(),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const session = await requireWordSessionPermissions(
        ctx,
        str(args.session_id)
      );
      const current = session.items[session.next_sequence] ?? null;
      if (
        session.next_sequence !== Number(args.sequence) ||
        current?.item_id !== str(args.word_id)
      ) {
        throw new WordToolError(
          'stale_word_session',
          'The Word session cursor changed; read the session again',
          409
        );
      }
      const action = args.action as WordObservationAction;
      const request = {
        request_id: str(args.request_id),
        boot_id: 'mcp-stateless',
        firmware_version: 'mcp-1.0.0',
        capabilities: ['word.study.mcp'],
        session_id: session.session_id,
        sequence: Number(args.sequence),
        item_id: str(args.word_id),
        action,
        mode: session.mode,
        occurred_at:
          optionalString(args.occurred_at) ?? new Date().toISOString(),
      };
      const observation =
        action === 'skipped'
          ? await skipWordStudyObservation(
              ctx.supabase,
              ctx.userId,
              null,
              request
            )
          : await recordWordStudyObservation(
              ctx.supabase,
              ctx.userId,
              null,
              request
            );
      return {
        observation,
        session: await loadWebWordStudySession(
          ctx.supabase,
          ctx.userId,
          session.session_id
        ),
      };
    },
  },
  {
    name: 'set_word_study_session_status',
    description:
      '暂停、恢复、完成或结束 Word 学习会话。completed 仅在所有候选已确认时成立。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Word 会话 ID' },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'completed', 'abandoned'],
        },
      },
      required: ['session_id', 'status'],
    },
    argsSchema: z.object({
      session_id: UuidSchema,
      status: z.enum(['active', 'paused', 'completed', 'abandoned']),
    }),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => {
      const session = await requireWordSessionPermissions(
        ctx,
        str(args.session_id)
      );
      return {
        session: await setWebWordStudySessionStatus(
          ctx.supabase,
          ctx.userId,
          session.session_id,
          args.status as 'active' | 'paused' | 'completed' | 'abandoned'
        ),
      };
    },
  },
];

const TODO_TOOLS: McpToolDefinition[] = [
  {
    name: 'get_todo',
    description:
      '按 ID 读取一个 Todo 的完整内容、时间、状态以及 Problem/Note/Word 关联。',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID' },
      },
      required: ['todo_id'],
    },
    argsSchema: z.object({ todo_id: UuidSchema }),
    annotations: READ_ONLY,
    handler: async (ctx, args) => ({
      todo: await getTodoById(ctx.supabase, ctx.userId, str(args.todo_id)),
    }),
  },
  {
    name: 'update_todo',
    description:
      '更新 Todo 的标题、说明、优先级、时间或 Problem/Note/Word 关联；仅修改传入字段。状态快捷修改继续使用 update_todo_status。',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        due_at: { type: ['string', 'null'] },
        reminder_at: { type: ['string', 'null'] },
        subject_id: { type: ['string', 'null'] },
        problem_set_id: { type: ['string', 'null'] },
        problem_id: { type: ['string', 'null'] },
        notebook_id: { type: ['string', 'null'] },
        note_id: { type: ['string', 'null'] },
        word_deck_id: { type: ['string', 'null'] },
        word_entry_id: { type: ['string', 'null'] },
      },
      required: ['todo_id'],
    },
    argsSchema: z
      .object({
        todo_id: UuidSchema,
        title: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(2000).nullable().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        due_at: IsoDateTimeSchema.nullable().optional(),
        reminder_at: IsoDateTimeSchema.nullable().optional(),
        subject_id: UuidSchema.nullable().optional(),
        problem_set_id: UuidSchema.nullable().optional(),
        problem_id: UuidSchema.nullable().optional(),
        notebook_id: UuidSchema.nullable().optional(),
        note_id: UuidSchema.nullable().optional(),
        word_deck_id: UuidSchema.nullable().optional(),
        word_entry_id: UuidSchema.nullable().optional(),
      })
      .refine(
        value =>
          value.title !== undefined ||
          value.description !== undefined ||
          value.priority !== undefined ||
          value.due_at !== undefined ||
          value.reminder_at !== undefined ||
          value.subject_id !== undefined ||
          value.problem_set_id !== undefined ||
          value.problem_id !== undefined ||
          value.notebook_id !== undefined ||
          value.note_id !== undefined ||
          value.word_deck_id !== undefined ||
          value.word_entry_id !== undefined,
        { message: 'At least one Todo field must be supplied' }
      ),
    annotations: IDEMPOTENT_WRITE,
    handler: async (ctx, args) => ({
      todo: await updateTodo(ctx.supabase, ctx.userId, str(args.todo_id), {
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(args.description !== undefined
          ? { description: args.description as string | null }
          : {}),
        ...(typeof args.priority === 'string'
          ? { priority: args.priority as TodoPriority }
          : {}),
        ...(args.due_at !== undefined
          ? { due_at: args.due_at as string | null }
          : {}),
        ...(args.reminder_at !== undefined
          ? { reminder_at: args.reminder_at as string | null }
          : {}),
        ...(args.subject_id !== undefined
          ? { subject_id: args.subject_id as string | null }
          : {}),
        ...(args.problem_set_id !== undefined
          ? { problem_set_id: args.problem_set_id as string | null }
          : {}),
        ...(args.problem_id !== undefined
          ? { problem_id: args.problem_id as string | null }
          : {}),
        ...(args.notebook_id !== undefined
          ? { notebook_id: args.notebook_id as string | null }
          : {}),
        ...(args.note_id !== undefined
          ? { note_id: args.note_id as string | null }
          : {}),
        ...(args.word_deck_id !== undefined
          ? { word_deck_id: args.word_deck_id as string | null }
          : {}),
        ...(args.word_entry_id !== undefined
          ? { word_entry_id: args.word_entry_id as string | null }
          : {}),
      }),
    }),
  },
];

export const MCP_TOOL_EXTENSIONS: McpToolDefinition[] = [
  ...COMMON_TOOLS,
  ...PROBLEM_TOOLS,
  ...NOTE_TOOLS,
  ...WORD_TOOLS,
  ...TODO_TOOLS,
];

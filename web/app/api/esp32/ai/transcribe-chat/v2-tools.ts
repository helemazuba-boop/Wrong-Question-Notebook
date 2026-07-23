// v2-tools.ts
// Bridges the streaming pipeline's ToolExecutor callback to the existing
// notebook/todo/word tool implementations in lib/notebooks.ts, lib/todos.ts
// and lib/words.ts. Argument parsing is intentionally tolerant — the
// DashScope streamed tool_call.arguments may arrive across multiple chunks
// with non-trivial whitespace, so we attempt JSON.parse first and fall back
// to a permissive regex extraction.

import {
  listAuthorizedNotebooks,
  createNotebookNoteFromAi,
  searchUserProblems,
  getProblemDetail,
} from '@/lib/notebooks';
import {
  listTodosForAi,
  createTodoFromAi,
  updateTodoStatusFromAi,
} from '@/lib/todos';
import {
  listAuthorizedWordDecks,
  createWordDeck,
  addWordEntryToDeck,
  searchWords,
} from '@/lib/words';
import { createServiceClient } from '@/lib/supabase-utils';
import type { ToolExecutor } from '@/lib/sse-pipeline-chat';

function parseArgsSafely(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export { parseArgsSafely as parseToolArguments };

export interface V2ToolContext {
  userId: string;
  conversationId?: string | null;
  deviceId?: string | null;
}

function safeDisplay(name: string): string {
  switch (name) {
    case 'list_authorized_notebooks':
      return 'Reading authorized notebooks';
    case 'create_notebook_note':
      return 'Writing note';
    case 'search_user_problems':
      return 'Searching problems';
    case 'get_problem_detail':
      return 'Reading problem';
    case 'list_todos':
      return 'Reading todos';
    case 'create_todo':
      return 'Creating todo';
    case 'update_todo_status':
      return 'Updating todo';
    case 'list_word_decks':
      return 'Reading decks';
    case 'create_word_deck':
      return 'Creating deck';
    case 'add_word_to_deck':
      return 'Adding word';
    case 'search_words':
      return 'Searching words';
    default:
      return 'Tool: ' + (name || 'unnamed');
  }
}

export function buildAiToolExecutor(ctx: V2ToolContext): ToolExecutor {
  const supabase = createServiceClient();
  const toolCtx = {
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    deviceId: ctx.deviceId,
    supabase,
  };
  return async function execute(name: string, rawArgs: string) {
    let args: Record<string, unknown> = {};
    try {
      args = parseArgsSafely(rawArgs) || {};
    } catch {
      args = {};
    }
    try {
      switch (name) {
        case 'list_authorized_notebooks': {
          await listAuthorizedNotebooks(toolCtx);
          return { ok: true, display: safeDisplay(name), action: undefined };
        }
        case 'create_notebook_note': {
          const r = await createNotebookNoteFromAi(toolCtx, {
            notebook_id: String(args.notebook_id || ''),
            title: String(args.title || ''),
            content: String(args.content || ''),
            linked_problem_id: (args.linked_problem_id as string) || null,
          });
          return { ok: true, display: 'Note saved', action: r.action };
        }
        case 'search_user_problems': {
          await searchUserProblems(toolCtx, {
            query: String(args.query || ''),
            subject_id: (args.subject_id as string) || undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return { ok: true, display: safeDisplay(name) };
        }
        case 'get_problem_detail': {
          await getProblemDetail(toolCtx, {
            problem_id: String(args.problem_id || ''),
          });
          return { ok: true, display: safeDisplay(name) };
        }
        case 'list_todos': {
          await listTodosForAi(toolCtx, {
            status:
              (args.status as 'pending' | 'completed' | 'cancelled' | 'all') ||
              'pending',
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return { ok: true, display: safeDisplay(name) };
        }
        case 'create_todo': {
          const r = await createTodoFromAi(toolCtx, {
            title: String(args.title || ''),
            description: (args.description as string) || undefined,
            priority: (args.priority as 'low' | 'normal' | 'high') || undefined,
            due_at: (args.due_at as string) || undefined,
            reminder_at: (args.reminder_at as string) || undefined,
            subject_id: (args.subject_id as string) || undefined,
            problem_id: (args.problem_id as string) || undefined,
            notebook_id: (args.notebook_id as string) || undefined,
          });
          return { ok: true, display: 'Todo created', action: r.action };
        }
        case 'update_todo_status': {
          const r = await updateTodoStatusFromAi(toolCtx, {
            todo_id: String(args.todo_id || ''),
            status:
              (args.status as 'pending' | 'completed' | 'cancelled') ||
              'pending',
          });
          return { ok: true, display: 'Todo updated', action: r.action };
        }
        case 'list_word_decks': {
          await listAuthorizedWordDecks(toolCtx);
          return { ok: true, display: safeDisplay(name) };
        }
        case 'create_word_deck': {
          const r = await createWordDeck(supabase, ctx.userId, {
            title: String(args.title || ''),
            description: (args.description as string) || undefined,
            subject_id: (args.subject_id as string) || undefined,
            language: (args.language as string) || undefined,
            target_language: (args.target_language as string) || undefined,
            lexicon_type:
              args.lexicon_type === 'classical_chinese_term'
                ? 'classical_chinese_term'
                : 'english_word',
            source: 'ai',
          });
          return { ok: true, display: 'Deck created', action: r.action };
        }
        case 'add_word_to_deck': {
          const r = await addWordEntryToDeck(
            supabase,
            ctx.userId,
            String(args.deck_id || ''),
            {
              word: String(args.word || ''),
              phonetic: (args.phonetic as string) || undefined,
              meaning: String(args.meaning || ''),
              example: (args.example as string) || undefined,
              example_translation:
                (args.example_translation as string) || undefined,
              part_of_speech: (args.part_of_speech as string) || undefined,
            }
          );
          return { ok: true, display: 'Word added', action: r.action };
        }
        case 'search_words': {
          await searchWords(supabase, ctx.userId, {
            q: (args.q as string) || undefined,
            prefix: (args.prefix as string) || undefined,
            deck_id: (args.deck_id as string) || undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return { ok: true, display: safeDisplay(name) };
        }
        default:
          return { ok: false, display: 'Unknown tool: ' + (name || 'unnamed') };
      }
    } catch {
      return {
        ok: false,
        display: safeDisplay(name) + ' failed',
      };
    }
  };
}

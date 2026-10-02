// v2-tools.ts
// Voice-side adapter over the shared MCP tool registry. The tool definitions
// sent to the device LLMs are projected from lib/mcp/tool-catalog.ts by
// lib/ai-tools/voice-tools.ts; this file only bridges the streaming
// pipeline's ToolExecutor callback (name + raw JSON args string) to the
// registry handlers: registry-scoped tool resolution, zod validation, error
// surfacing, and the device-facing {ok, display, data, action} envelope.
//
// Only the catalog's VOICE_TOOL_NAMES are executable here -- the registry
// serves 38+ tools to external MCP clients, and the voice LLM must not be
// able to reach (and pay for) the rest by hallucinating a name.

import { createServiceClient } from '@/lib/supabase-utils';
import { logger } from '@/lib/logger';
import { findMcpTool, type McpToolContext } from '@/lib/mcp/tool-registry';
import { isVoiceToolName, type VoiceToolName } from '@/lib/mcp/tool-catalog';
import type { ToolExecutor } from '@/lib/sse-pipeline-chat';

export interface V2ToolContext {
  userId: string;
  conversationId?: string | null;
  deviceId?: string | null;
}

export interface VoiceToolError {
  code: string;
  message: string;
}

// Device-facing status strings rendered by the firmware (tool.result /
// tool.done) and mirrored into the model context. Writes have a progress
// phrasing (used on failure) and a past-tense phrasing (used on success);
// reads share one phrasing. Keep the vocabulary the firmware already shows.
const DISPLAY: Record<VoiceToolName, { progress: string; success: string }> = {
  list_authorized_notebooks: {
    progress: 'Reading authorized notebooks',
    success: 'Reading authorized notebooks',
  },
  create_notebook_note: { progress: 'Writing note', success: 'Note saved' },
  search_user_problems: {
    progress: 'Searching problems',
    success: 'Searching problems',
  },
  get_problem_detail: {
    progress: 'Reading problem',
    success: 'Reading problem',
  },
  list_todos: { progress: 'Reading todos', success: 'Reading todos' },
  create_todo: { progress: 'Creating todo', success: 'Todo created' },
  update_todo_status: {
    progress: 'Updating todo',
    success: 'Todo updated',
  },
  list_authorized_word_decks: {
    progress: 'Reading decks',
    success: 'Reading decks',
  },
  create_word_deck: { progress: 'Creating deck', success: 'Deck created' },
  add_word_entry: { progress: 'Adding word', success: 'Word added' },
  search_words: { progress: 'Searching words', success: 'Searching words' },
};

function displayFor(name: string, outcome: 'progress' | 'success'): string {
  const entry = DISPLAY[name as VoiceToolName];
  if (!entry) return 'Tool: ' + (name || 'unnamed');
  return outcome === 'success' ? entry.success : entry.progress;
}

function failureDisplay(name: string): string {
  return displayFor(name, 'progress') + ' failed';
}

// Summarise zod issues as "path: reason" pairs without echoing back the
// offending values themselves.
function invalidArgumentsMessage(
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
): string {
  return issues
    .slice(0, 3)
    .map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
}

function errorPayload(error: unknown): VoiceToolError {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.message === 'string') {
      return {
        code:
          typeof candidate.code === 'string'
            ? candidate.code
            : 'tool_execution_failed',
        message: candidate.message,
      };
    }
  }
  return { code: 'tool_execution_failed', message: 'Tool execution failed' };
}

export function buildAiToolExecutor(ctx: V2ToolContext): ToolExecutor {
  const toolCtx: McpToolContext = {
    userId: ctx.userId,
    conversationId: ctx.conversationId ?? null,
    deviceId: ctx.deviceId ?? null,
    supabase: createServiceClient(),
  };
  return async function execute(name: string, rawArgs: string) {
    if (!name || !isVoiceToolName(name)) {
      return { ok: false, display: 'Unknown tool: ' + (name || 'unnamed') };
    }
    const tool = findMcpTool(name);
    if (!tool) {
      // The catalog and the registry drifted -- a contract test locks them
      // together, so this should never happen in a deployed build.
      logger.error('Voice tool missing from MCP registry', {
        component: 'Esp32VoiceTools',
        toolName: name,
      });
      return { ok: false, display: failureDisplay(name) };
    }

    let args: Record<string, unknown> = {};
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Unusable JSON falls through with empty args; the schema gate below
        // rejects the call and the error text tells the model why.
      }
    }

    const parsedArgs = tool.argsSchema.safeParse(args);
    if (!parsedArgs.success) {
      const message = `Invalid arguments: ${invalidArgumentsMessage(parsedArgs.error.issues)}`;
      logger.warn('Voice tool arguments rejected', {
        component: 'Esp32VoiceTools',
        toolName: name,
        userId: ctx.userId,
        message,
      });
      return {
        ok: false,
        display: failureDisplay(name),
        error: { code: 'invalid_arguments', message },
      };
    }

    try {
      const data = await tool.handler(
        toolCtx,
        parsedArgs.data as Record<string, unknown>
      );
      const action =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as { action?: unknown }).action
          : undefined;
      return { ok: true, display: displayFor(name, 'success'), data, action };
    } catch (error) {
      const payload = errorPayload(error);
      logger.warn('Voice tool call failed', {
        component: 'Esp32VoiceTools',
        toolName: name,
        userId: ctx.userId,
        message: payload.message,
      });
      return {
        ok: false,
        display: failureDisplay(name),
        error: payload,
      };
    }
  };
}

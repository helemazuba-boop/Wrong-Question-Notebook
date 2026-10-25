// Device voice: eight focused tools, with server-owned context and receipts.
import { randomUUID } from 'crypto';
import { createServiceClient } from '@/lib/supabase-utils';
import { getAppOrigin } from '@/lib/app-origin';
import { findMcpTool, type McpToolContext } from '@/lib/mcp/tool-registry';
import {
  isVoiceToolName,
  findCatalogTool,
  type VoiceToolName,
} from '@/lib/mcp/tool-catalog';
import { readV2 } from '@/lib/mcp/v2-readers';
import { voiceArgsSchema } from '@/lib/ai-tools/voice-schemas';
import { executeVoiceWrite, voiceRequestId } from '@/lib/ai-tools/voice-write';
import type { VoiceTimeContext } from '@/lib/ai-tools/voice-context';
import type { ToolExecutor } from '@/lib/sse-pipeline-chat';
import { logger } from '@/lib/logger';

export interface V2ToolContext {
  userId: string;
  conversationId?: string | null;
  deviceId?: string | null;
  requestId?: string;
  timeContext?: VoiceTimeContext;
  supabase?: McpToolContext['supabase'];
}
const DISPLAY: Record<VoiceToolName, { progress: string; success: string }> = {
  create_notebook_note: { progress: 'Writing note', success: 'Note saved' },
  list_problem_sets: {
    progress: 'Reading problem sets',
    success: 'Reading problem sets',
  },
  list_problem_set_problems: {
    progress: 'Reading problems',
    success: 'Reading problems',
  },
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
  update_todo_status: { progress: 'Updating todo', success: 'Todo updated' },
};
export function buildAiToolExecutor(ctx: V2ToolContext): ToolExecutor {
  const toolCtx: McpToolContext = {
    userId: ctx.userId,
    conversationId: ctx.conversationId ?? null,
    deviceId: ctx.deviceId ?? null,
    origin: getAppOrigin(),
    supabase: ctx.supabase ?? createServiceClient(),
  };
  const turnId = ctx.requestId ?? randomUUID();
  const fallbackTime: VoiceTimeContext = ctx.timeContext ?? {
    now: new Date().toISOString(),
    timezone: 'UTC',
  };
  const execute: ToolExecutor = async (name, rawArgs, meta) => {
    if (!isVoiceToolName(name))
      return { ok: false, display: `Unknown tool: ${name || 'unnamed'}` };
    const display = DISPLAY[name];
    try {
      let input: unknown = {};
      if (rawArgs)
        try {
          input = JSON.parse(rawArgs);
        } catch {
          return {
            ok: false,
            display: `${display.progress} failed`,
            error: {
              code: 'invalid_arguments',
              message: 'Invalid JSON arguments',
            },
          };
        }
      const parsed = voiceArgsSchema(name).safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          display: `${display.progress} failed`,
          error: {
            code: 'invalid_arguments',
            message: parsed.error.issues
              .slice(0, 3)
              .map(i => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          },
        };
      const args = parsed.data as Record<string, any>;
      const executionSignal =
        findCatalogTool(name)?.annotations?.readOnlyHint === true
          ? meta?.signal
          : meta?.writeSignal;
      const executionCtx = executionSignal
        ? {
            ...toolCtx,
            supabase:
              ctx.supabase ?? createServiceClient({ signal: executionSignal }),
          }
        : toolCtx;
      let data: Record<string, any>;
      if (
        ['create_notebook_note', 'create_todo', 'update_todo_status'].includes(
          name
        )
      ) {
        if (!ctx.deviceId || !meta?.callId)
          throw Object.assign(
            new Error('缺少设备或调用 ID，不能安全执行写入。'),
            { code: 'write_identity_required' }
          );
        data = await executeVoiceWrite(
          executionCtx,
          name,
          args,
          meta.requestId ?? voiceRequestId(ctx.deviceId, turnId, meta.callId),
          ctx.timeContext ?? fallbackTime
        );
      } else if (name === 'get_problem_detail') {
        const result = (await readV2(executionCtx, name, args)) as Record<
          string,
          any
        >;
        data = { problem: result.item };
      } else if (
        name === 'list_problem_sets' ||
        name === 'list_problem_set_problems'
      ) {
        const result = (await readV2(executionCtx, name, args)) as Record<
          string,
          any
        >;
        data = {
          ...result,
          [name === 'list_problem_sets' ? 'problem_sets' : 'problems']:
            result.items,
        };
        delete data.items;
      } else
        data = (await findMcpTool(name)!.handler(executionCtx, args)) as Record<
          string,
          any
        >;
      return { ok: true, display: display.success, data, action: data.action };
    } catch (error) {
      const e = error as {
        code?: string;
        message?: string;
        retryable?: boolean;
      };
      return {
        ok: false,
        display: ['unknown_outcome', 'operation_in_progress'].includes(
          e.code ?? ''
        )
          ? 'Write result pending confirmation'
          : `${display.progress} failed`,
        error: {
          code: e.code ?? 'tool_execution_failed',
          message: e.message ?? 'Tool execution failed',
          retryable: Boolean(e.retryable),
        },
      };
    }
  };
  return async (name, rawArgs, meta) => {
    const startedAt = Date.now();
    const identity = {
      component: 'Esp32VoiceTool',
      toolName: isVoiceToolName(name) ? name : 'unknown_tool',
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      requestId:
        meta?.requestId ??
        (ctx.deviceId && meta?.callId
          ? voiceRequestId(ctx.deviceId, turnId, meta.callId)
          : turnId),
    };
    logger.info('ESP32 voice tool started', identity);
    const result = await execute(name, rawArgs, meta);
    // Never log arguments, titles, content, model reasoning, or raw DB errors.
    const errorCode = result.error?.code;
    logger[result.ok ? 'info' : 'warn']('ESP32 voice tool completed', {
      ...identity,
      ok: result.ok,
      elapsed_ms: Date.now() - startedAt,
      errorCode:
        errorCode && /^[a-z][a-z0-9_]{0,79}$/.test(errorCode)
          ? errorCode
          : result.ok
            ? undefined
            : 'tool_execution_failed',
      retryable: result.error?.retryable ?? false,
    });
    return result;
  };
}

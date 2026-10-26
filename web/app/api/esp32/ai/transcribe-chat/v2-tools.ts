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
import {
  AskQuestionSchema,
  type VoiceInteractionGateway,
} from '@/lib/ai-tools/voice-interaction';
import { throwIfVoiceStopped } from '@/lib/voice-operation';
import { resolveVoiceDate } from '@/lib/ai-tools/voice-context';

export interface V2ToolContext {
  requireConfirmation?: boolean;
  notebooks?: Array<{ id: string; title: string }>;
  interaction?: VoiceInteractionGateway;
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
    if (name === 'ask_question') {
      try {
        if (!ctx.interaction || !meta?.callId)
          throw Object.assign(new Error('当前设备不支持选项问答。'), {
            code: 'interaction_required',
          });
        const question = AskQuestionSchema.parse(JSON.parse(rawArgs));
        const reply = await ctx.interaction.ask(
          meta.callId,
          {
            kind: 'question',
            prompt: question.question,
            options: question.options,
            allow_custom: true,
          },
          meta.signal
        );
        const answer = typeof reply === 'string' ? reply : reply.answer;
        if (answer === '__custom__')
          return {
            ok: false,
            display: '已中断，请重新输入',
            error: {
              code: 'user_cancelled',
              message: '用户选择自己回答。',
              retryable: false,
            },
          };
        return {
          ok: true,
          display: '已收到回答',
          data: {
            answer,
            label: question.options.find(o => o.value === answer)?.label,
          },
        };
      } catch (error) {
        return {
          ok: false,
          stop: true,
          display: '问题未完成',
          error: {
            code: 'question_failed',
            message: error instanceof Error ? error.message : '问题未完成',
            retryable: false,
          },
        };
      }
    }
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
        let writeTime = ctx.timeContext ?? fallbackTime;
        let writeArgs = args;
        if (ctx.requireConfirmation) {
          if (
            name === 'create_notebook_note' &&
            ctx.notebooks &&
            !ctx.notebooks.some(n => n.id === args.notebook_id)
          )
            throw Object.assign(new Error('请先授权或选择目标笔记本。'), {
              code: 'notebook_permission_denied',
            });
          if (!ctx.interaction)
            throw Object.assign(new Error('请更新固件后在设备上确认写入。'), {
              code: 'confirmation_required',
            });
          const time = ctx.timeContext ?? fallbackTime;
          // Resolve time before displaying it; the exact time/arguments travel
          // together, even if the user confirms across midnight.
          const lines = [
            name === 'create_notebook_note'
              ? '写入笔记'
              : name === 'create_todo'
                ? '新增 Todo'
                : '修改 Todo 状态',
            String(args.title ?? args.todo_id ?? ''),
          ];
          if (name === 'create_notebook_note')
            lines.push(
              '笔记本：' +
                (ctx.notebooks?.find(n => n.id === args.notebook_id)?.title ??
                  String(args.notebook_id)),
              '内容摘要：' + String(args.content)
            );
          if (name === 'update_todo_status')
            lines.push('状态：' + String(args.status));
          const due = args.due ? resolveVoiceDate(args.due, time) : args.due_at;
          const reminder = args.reminder
            ? resolveVoiceDate(args.reminder, time, true)
            : args.reminder_at;
          const local = (value: string) =>
            new Date(value).toLocaleString('zh-CN', {
              timeZone: time.timezone,
              hour12: false,
            });
          if (due) lines.push('截止：' + local(String(due)));
          if (reminder) lines.push('提醒：' + local(String(reminder)));
          if (name === 'create_todo' && args.description)
            lines.push('说明：' + String(args.description));
          const reply = await ctx.interaction.ask(
            meta.callId,
            {
              kind: 'write',
              prompt: Array.from(lines.join('\n')).slice(0, 1800).join(''),
              options: [
                { label: '执行', value: 'approve' },
                { label: '取消', value: 'reject' },
              ],
              allow_custom: false,
              command: { name, args, time },
            },
            meta.signal
          );
          const answer = typeof reply === 'string' ? reply : reply.answer;
          if (typeof reply !== 'string' && reply.command) {
            writeTime = reply.command.time;
            writeArgs = reply.command.args;
          }
          if (answer !== 'approve')
            return {
              ok: false,
              display: '已取消，未执行写入',
              error: {
                code: 'user_cancelled',
                message: '用户取消本次写入。',
                retryable: false,
              },
            };
          throwIfVoiceStopped(meta.signal);
        }
        data = await executeVoiceWrite(
          executionCtx,
          name,
          writeArgs,
          meta.requestId ?? voiceRequestId(ctx.deviceId, turnId, meta.callId),
          writeTime
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
        ...(ctx.requireConfirmation &&
        ['interaction_expired', 'interaction_unavailable'].includes(
          e.code ?? ''
        )
          ? { stop: true }
          : {}),
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
      toolName:
        isVoiceToolName(name) || name === 'ask_question'
          ? name
          : 'unknown_tool',
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

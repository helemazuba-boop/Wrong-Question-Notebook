import 'server-only';
import { createHash, randomUUID } from 'crypto';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
import {
  fingerprint,
  operationRpc,
  loadOperation,
  OperationExecutor,
  McpV2Error,
  type Operation,
} from '@/lib/mcp/v2-operations';
import { resolveVoiceDate, type VoiceTimeContext } from './voice-context';
import { NOTE_CONTENT_FORMAT } from '@/lib/note-content-format';
export function voiceRequestId(
  deviceId: string,
  turnId: string,
  callId: string
) {
  return `voice_${createHash('sha256').update(`${deviceId}\0${turnId}\0${callId}`).digest('hex').slice(0, 48)}`;
}
export async function executeVoiceWrite(
  ctx: McpToolContext,
  name: string,
  args: Record<string, any>,
  requestId: string,
  time: VoiceTimeContext
) {
  if (!ctx.deviceId)
    throw new McpV2Error('device_context_required', '设备上下文不可用。');
  const op: Operation = await operationRpc(
    ctx,
    'begin_mcp_voice_operation_v1',
    {
      p_user_id: ctx.userId,
      p_device_id: ctx.deviceId,
      p_tool_name: name,
      p_request_id: requestId,
      p_fingerprint: fingerprint(`voice:${name}`, args),
      p_arguments: args,
    }
  );
  const executor = new OperationExecutor(
    ctx,
    op,
    'commit_mcp_voice_operation_v1'
  );
  if (op.state === 'failed' && !op.claimed)
    throw new McpV2Error(
      op.error?.code ?? 'voice_write_failed',
      op.error?.message ?? '原写入尚未提交。',
      Boolean(op.error?.retryable)
    );
  if (op.state !== 'committed' && !op.claimed)
    throw new McpV2Error(
      'operation_in_progress',
      '原写入仍在执行；不能创建第二份。',
      true
    );
  executor.startRenewal();
  try {
    if (op.state !== 'committed' && !op.prepared) {
      let command: Record<string, any>;
      if (name === 'create_todo') {
        const { due, reminder, ...fields } = args;
        const row = {
          ...fields,
          id: randomUUID(),
          user_id: ctx.userId,
          due_at: due ? resolveVoiceDate(due, time) : (fields.due_at ?? null),
          reminder_at: reminder
            ? resolveVoiceDate(reminder, time, true)
            : (fields.reminder_at ?? null),
          source: 'ai',
          created_by: 'ai',
          source_device_id: ctx.deviceId,
          source_conversation_id: ctx.conversationId ?? null,
        };
        command = { kind: 'insert', table: 'todos', row, time_context: time };
      } else if (name === 'create_notebook_note') {
        const { client_request_id: ignored, ...fields } = args;
        void ignored;
        command = {
          kind: 'insert',
          table: 'notebook_notes',
          row: {
            ...fields,
            id: randomUUID(),
            user_id: ctx.userId,
            source: 'ai',
            content_format: NOTE_CONTENT_FORMAT,
            metadata: { source_conversation_id: ctx.conversationId ?? null },
            client_request_id: requestId,
          },
          time_context: time,
        };
      } else command = { kind: 'todo_status' };
      await executor.prepare(command);
    }
    const receipt =
      op.state === 'committed'
        ? await operationRpc(ctx, 'commit_mcp_voice_operation_v1', {
            p_user_id: ctx.userId,
            p_operation_id: op.id,
            p_lease_token: null,
          }).then(value => value.receipt)
        : await executor.commit();
    return resultOf(name, receipt.row);
  } catch (error) {
    if (op.state === 'committed') throw error;
    if (!executor.committing) await executor.fail(error).catch(() => {});
    const latest = await loadOperation(ctx, { id: op.id }).catch(() => null);
    if (latest?.state === 'committed')
      return resultOf(name, latest.receipt!.row);
    if (executor.committing && latest?.state !== 'failed')
      throw new McpV2Error(
        'unknown_outcome',
        '写入结果暂时无法确认，请勿再次新建。',
        true
      );
    throw error;
  } finally {
    executor.stop();
  }
}
function resultOf(name: string, row: Record<string, any>) {
  if (name === 'create_notebook_note')
    return {
      note: row,
      action: {
        type: 'notebook_note_created',
        notebook_id: row.notebook_id,
        note_id: row.id,
        title: row.title,
      },
    };
  return {
    todo: row,
    action: {
      type: name === 'create_todo' ? 'todo_created' : 'todo_status_updated',
      todo_id: row.id,
      title: row.title,
      status: row.status,
      due_at: row.due_at,
      reminder_at: row.reminder_at,
    },
  };
}

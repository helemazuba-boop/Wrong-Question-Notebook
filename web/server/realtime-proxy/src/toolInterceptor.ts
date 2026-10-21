/**
 * toolInterceptor.ts — intercepts `response.function_call_arguments.done`
 * from the StepFun Realtime upstream, executes the named tool against
 * authoritative state via HTTP, then feeds the result back as an
 * assistant-injected `conversation.item.create + response.create`. The
 * Tool definitions and execution stay server-side. The ESP32 only receives
 * bounded tool.start/tool.result/tool.error events plus the final TTS response.
 *
 * Why HTTP, not in-process: see
 *   web/app/api/esp32/ai/execute-tool/route.ts (header comment).
 */

import { createHash, createHmac } from 'crypto';
import { log } from './logger.ts';
import type { VoiceContext } from '../../../lib/ai-tools/voice-context.ts';

const TOOL_TIMEOUT_MS = 12_000;

export interface ToolCallArgs {
  call_id: string;
  name: string;
  raw_args: string;
}

export interface ToolExecResult {
  ok: boolean;
  display: string;
  data?: unknown;
  action: unknown;
  error?: { code: string; message: string; retryable?: boolean } | null;
}

export interface Upstream {
  sendText(message: string): void;
}

export async function executeToolOverHttp(
  endpoint: string,
  secret: string,
  userId: string,
  deviceId: string,
  args: ToolCallArgs,
  anchorAt?: string
): Promise<ToolExecResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOOL_TIMEOUT_MS);
  const requestId = `tool_${createHash('sha256')
    .update(`${deviceId}\0${args.call_id}`)
    .digest('hex')
    .slice(0, 48)}`;
  const writes = [
    'create_notebook_note',
    'create_todo',
    'update_todo_status',
  ].includes(args.name);
  const transportFailure = (): ToolExecResult => ({
    ok: false,
    display: writes
      ? 'Write result pending confirmation'
      : 'Tool service unavailable',
    action: null,
    error: {
      code: writes ? 'unknown_outcome' : 'tool_transport_failed',
      message: writes
        ? '未收到可靠的写入回执，原写入可能已执行。请勿另起调用重复新建。'
        : '暂时无法连接工具服务，请稍后重试。',
      retryable: true,
    },
  });
  try {
    const body = JSON.stringify({
      request_id: requestId,
      user_id: userId,
      device_id: deviceId,
      tool_name: args.name,
      raw_args: args.raw_args,
      anchor_at: anchorAt,
    });
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', secret)
      .update(timestamp)
      .update('\n')
      .update(body)
      .digest('hex');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-wqn-internal-timestamp': timestamp,
        'x-wqn-internal-signature': signature,
      },
      body,
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: ToolExecResult;
      error?: { code?: string };
    };
    if (
      !res.ok ||
      !json.success ||
      typeof json.result?.ok !== 'boolean' ||
      typeof json.result?.display !== 'string'
    ) {
      const rejected =
        !res.ok &&
        ['unauthorized', 'bad_request', 'disabled'].includes(
          json.error?.code ?? ''
        );
      log.warn('tool exec failed', {
        toolName: args.name,
        requestId,
        status: res.status,
        errorCode: rejected ? json.error!.code : transportFailure().error!.code,
      });
      return rejected
        ? {
            ok: false,
            display: `Tool ${args.name} failed`,
            action: null,
            error: {
              code: json.error!.code!,
              message:
                json.error!.code === 'bad_request'
                  ? '工具服务拒绝了请求格式，写入未执行。'
                  : '语音工具服务校验未通过或未配置，写入未执行，请检查服务配置。',
              retryable: false,
            },
          }
        : transportFailure();
    }
    return json.result;
  } catch {
    log.warn('tool exec threw', {
      toolName: args.name,
      requestId,
      errorCode: transportFailure().error!.code,
      timedOut: ctrl.signal.aborted,
    });
    return transportFailure();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchVoiceContext(
  endpoint: string,
  secret: string,
  userId: string,
  deviceId: string,
  anchorAt = new Date().toISOString()
): Promise<VoiceContext> {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/execute-tool$/, 'context');
  const body = JSON.stringify({
    user_id: userId,
    device_id: deviceId,
    anchor_at: anchorAt,
  });
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret)
    .update(timestamp)
    .update('\n')
    .update(body)
    .digest('hex');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'x-wqn-internal-timestamp': timestamp,
      'x-wqn-internal-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const result = (await response.json()) as { data?: VoiceContext };
  if (
    !response.ok ||
    !result.data ||
    !Array.isArray(result.data.notebooks) ||
    !Number.isFinite(Date.parse(result.data.now))
  )
    throw new Error('Voice context unavailable');
  return result.data;
}

/**
 * Inject a tool result back upstream as if the device produced it:
 *   conversation.item.create (role=tool, call_id)
 *   response.create       (force next turn)
 * This is the same shape openai/openai-realtime-console relay uses
 * (see that project's relay.js — we mirror its call/cancelItem logic).
 */
export function injectToolResult(
  upstream: Upstream,
  args: ToolCallArgs,
  result: ToolExecResult,
  continueResponse = true
) {
  const toolItem = {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: args.call_id,
      output: JSON.stringify({
        ok: result.ok,
        display: result.display,
        data: result.data ?? null,
        action: result.action ?? null,
        error: result.error ?? null,
      }),
    },
  };
  upstream.sendText(JSON.stringify(toolItem));
  if (!continueResponse) return;
  // Ask the model to keep talking so the user hears the result narrated
  // by the TTS layer.
  const trigger = {
    type: 'response.create',
    response: { modalities: ['text', 'audio'] },
  };
  upstream.sendText(JSON.stringify(trigger));
}

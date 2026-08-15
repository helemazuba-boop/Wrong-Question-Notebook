/**
 * toolInterceptor.ts — intercepts `response.function_call_arguments.done`
 * from the StepFun Realtime upstream, executes the named tool against
 * authoritative state via HTTP, then feeds the result back as an
 * assistant-injected `conversation.item.create + response.create`. The
 * Tool definitions and execution stay server-side. The ESP32 only receives
 * bounded tool.start/tool.done status events plus the final TTS response.
 *
 * Why HTTP, not in-process: see
 *   web/app/api/esp32/ai/execute-tool/route.ts (header comment).
 */

import { createHash, createHmac } from 'crypto';
import { log } from './logger.ts';

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
}

export interface Upstream {
  sendText(message: string): void;
}

export async function executeToolOverHttp(
  endpoint: string,
  secret: string,
  userId: string,
  deviceId: string,
  args: ToolCallArgs
): Promise<ToolExecResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOOL_TIMEOUT_MS);
  try {
    const requestId = `tool_${createHash('sha256')
      .update(`${deviceId}\0${args.call_id}`)
      .digest('hex')
      .slice(0, 48)}`;
    const body = JSON.stringify({
      request_id: requestId,
      user_id: userId,
      device_id: deviceId,
      tool_name: args.name,
      raw_args: args.raw_args,
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
      error?: { message?: string };
    };
    if (!res.ok || !json.success || !json.result) {
      log.warn('tool exec failed', {
        toolName: args.name,
        status: res.status,
        err: json.error?.message,
      });
      return {
        ok: false,
        display: `Tool ${args.name} failed`,
        action: null,
      };
    }
    return json.result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('tool exec threw', { toolName: args.name, err: msg });
    return { ok: false, display: `Tool ${args.name} failed`, action: null };
  } finally {
    clearTimeout(t);
  }
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
  result: ToolExecResult
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
      }),
    },
  };
  upstream.sendText(JSON.stringify(toolItem));
  // Ask the model to keep talking so the user hears the result narrated
  // by the TTS layer.
  const trigger = {
    type: 'response.create',
    response: { modalities: ['text', 'audio'] },
  };
  upstream.sendText(JSON.stringify(trigger));
}

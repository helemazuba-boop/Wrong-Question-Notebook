// sse-pipeline-chat.ts
// Streaming DashScope chat completion. We call /chat/completions with
// stream:true, consume the OpenAI-style SSE upstream, and translate each
// chunk into WQN SSE frames: text.start/text.delta/text.end, plus
// tool.start/tool.result when the assistant emits a function call.

import { Esp32AiProviderError } from './esp32-ai-provider';
import {
  appendTurns,
  contextTurnsForLlm,
  loadTurns,
  mintConversationId,
} from './esp32-ai-conversation-store';
import {
  applyToolCallDelta,
  sealToolCalls,
  type AccumulatedToolCall,
  type OaiChatChunk,
  type PipelinePusher,
} from './sse-pipeline-types';

export interface ChatStreamConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  llmTimeoutMs: number;
  systemPrompt: string;
}

export interface ChatStreamInput {
  transcript: string;
  conversationId?: string | null;
  tier?: string | null;
  userId?: string | null;
  deviceId?: string | null;
}

export interface ChatStreamResult {
  replyText: string;
  conversationId: string;
  requestId: string | null;
  actions: unknown[];
  functionCalls: Array<{
    name: string;
    status: 'succeeded' | 'failed';
    display: string;
  }>;
}

export interface ToolExecutor {
  (
    name: string,
    rawArgs: string
  ): Promise<{
    ok: boolean;
    display: string;
    action?: unknown;
  }>;
}

export async function runPipelineChat(
  config: ChatStreamConfig,
  input: ChatStreamInput,
  pusher: PipelinePusher,
  toolExecutor?: ToolExecutor
): Promise<ChatStreamResult> {
  const startedAt = Date.now();
  pusher.emitStage('chat_started');

  // Resolve / mint the conversation id and load prior turns for multi-turn
  // context. STD/PRO share one history per the "temporary sharing" decision;
  // the conversation_id (not the tier) groups turns. Flash never reaches
  // here - it uses the realtime WS proxy with its own context management.
  const conversationId = input.conversationId || mintConversationId();
  const priorTurns = input.userId
    ? await loadTurns(input.userId, conversationId)
    : [];

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: config.systemPrompt },
  ];
  for (const turn of contextTurnsForLlm(priorTurns)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: input.transcript });

  let lastRequestId: string | null = null;
  let fullReply = '';
  const allActions: unknown[] = [];
  const functionCalls: ChatStreamResult['functionCalls'] = [];

  for (let round = 0; round < 4; round += 1) {
    const hasTools = Boolean(toolExecutor);
    const response = await fetchStreamingCompletion(
      config,
      messages,
      hasTools,
      pusher
    );
    lastRequestId = response.requestId || lastRequestId;
    if (response.content) {
      fullReply += response.content;
    }
    if (!response.toolCalls || response.toolCalls.length === 0) {
      pusher.emitStage('chat_done', { elapsed_ms: Date.now() - startedAt });
      // Persist the completed (user, assistant) turn pair so the next turn
      // in this conversation has multi-turn context. Best-effort: appendTurns
      // swallows its own errors so a storage failure never fails the reply
      // the user just received. The cache is updated synchronously inside
      // appendTurns, so a same-visit follow-up sees this turn immediately.
      if (input.userId && fullReply) {
        const now = new Date().toISOString();
        await appendTurns(
          input.userId,
          conversationId,
          input.tier || 'std',
          input.deviceId ?? null,
          [
            { role: 'user', content: input.transcript, created_at: now },
            { role: 'assistant', content: fullReply, created_at: now },
          ]
        );
      }
      return {
        replyText: fullReply,
        conversationId,
        requestId: lastRequestId,
        actions: allActions,
        functionCalls,
      };
    }
    // Tool loop
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls,
    });
    for (const call of response.toolCalls) {
      pusher.emitToolStart(
        call.id,
        call.function.name,
        response.toolCalls.indexOf(call)
      );
      const t0 = Date.now();
      let result: { ok: boolean; display: string; action?: unknown };
      try {
        result = toolExecutor
          ? await toolExecutor(call.function.name, call.function.arguments)
          : { ok: false, display: 'No tool executor registered' };
      } catch (err) {
        result = {
          ok: false,
          display: err instanceof Error ? err.message : 'tool failed',
        };
      }
      if (result.action) allActions.push(result.action);
      functionCalls.push({
        name: call.function.name,
        status: result.ok ? 'succeeded' : 'failed',
        display: result.display,
      });
      pusher.emitToolResult({
        tool_call_id: call.id,
        name: call.function.name,
        ok: result.ok,
        display: result.display,
        elapsed_ms: Date.now() - t0,
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  throw new Esp32AiProviderError(
    'model_failed',
    'DashScope chat tool loop exceeded maximum rounds',
    500
  );
}

async function fetchStreamingCompletion(
  config: ChatStreamConfig,
  messages: Array<Record<string, unknown>>,
  hasTools: boolean,
  pusher: PipelinePusher
): Promise<{
  requestId: string | null;
  content: string | null;
  toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}> {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, config.llmTimeoutMs);
  try {
    const body = {
      model: config.model,
      messages,
      stream: true,
      temperature: 0.3,
    };
    const r = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok || !r.body) {
      const code =
        r.status === 429
          ? 'rate_limited'
          : r.status >= 500
            ? 'provider_unavailable'
            : 'model_failed';
      throw new Esp32AiProviderError(
        code,
        'DashScope chat HTTP ' + r.status,
        r.status
      );
    }
    return await consumeOpenAiSse(r.body, pusher, hasTools);
  } finally {
    clearTimeout(timer);
  }
}

interface ConsumedStream {
  requestId: string | null;
  content: string | null;
  toolCalls: ReturnType<typeof sealToolCalls>;
}

async function consumeOpenAiSse(
  body: ReadableStream<Uint8Array>,
  pusher: PipelinePusher,
  hasTools: boolean
): Promise<ConsumedStream> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let requestId: string | null = null;
  const acc: AccumulatedToolCall[] = [];
  let firstDeltaEmitted = false;
  function handleEvent(text: string): void {
    const lines = text.split('\n');
    let data = '';
    for (const line of lines) {
      if (line.indexOf('data:') === 0) data += line.slice(5).trim();
    }
    if (!data || data === '[DONE]') return;
    let json: OaiChatChunk;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.id && !requestId) requestId = json.id;
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!firstDeltaEmitted) {
        pusher.openSentence();
        firstDeltaEmitted = true;
      }
      pusher.appendDelta(delta.content);
      content += delta.content;
      pusher.emitStage('chat_streaming', { char_count: content.length });
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      applyToolCallDelta(acc, delta.tool_calls);
    }
    if (choice.finish_reason) {
      if (firstDeltaEmitted) pusher.closeSentence();
    }
  }
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const eventText = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleEvent(eventText);
    }
  }
  return {
    requestId,
    content: content || null,
    toolCalls: hasTools ? sealToolCalls(acc) : [],
  };
}

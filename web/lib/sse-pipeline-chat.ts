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
import { logger } from './logger';
import {
  applyToolCallDelta,
  sealToolCalls,
  type AccumulatedToolCall,
  type OaiChatChunk,
  type PipelinePusher,
} from './sse-pipeline-types';
import { takeNextSseEvent } from './sse-events';
import { AI_TOOLS } from './ai-tools/voice-tools';

export interface ChatStreamConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  llmTimeoutMs: number;
  systemPrompt: string;
  enableThinking?: boolean;
  thinkingBudget?: number;
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
  model: string;
  finishReason: string | null;
  reasoningBytes: number;
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
    data?: unknown;
    action?: unknown;
    error?: { code: string; message: string };
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
  let lastFinishReason: string | null = null;
  let lastReasoningBytes = 0;
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
    lastFinishReason = response.finishReason ?? lastFinishReason;
    lastReasoningBytes = response.reasoningBytes;
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
      if (!fullReply) {
        warnEmptyReply({
          model: config.model,
          finishReason: lastFinishReason,
          reasoningBytes: lastReasoningBytes,
          contentBytes: Buffer.byteLength(fullReply, 'utf8'),
          toolRounds: round + 1,
          transcriptBytes: Buffer.byteLength(input.transcript, 'utf8'),
          requestId: lastRequestId,
        });
      }
      return {
        replyText: fullReply,
        conversationId,
        requestId: lastRequestId,
        model: config.model,
        finishReason: lastFinishReason,
        reasoningBytes: lastReasoningBytes,
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
      let result: Awaited<ReturnType<ToolExecutor>>;
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

function warnEmptyReply(input: {
  model: string;
  finishReason: string | null;
  reasoningBytes: number;
  contentBytes: number;
  toolRounds: number;
  transcriptBytes: number;
  requestId: string | null;
}): void {
  // A "successful" completion with zero content is the exact signature of the
  // device complaint "transcription appeared, no answer". The reasoning length
  // separates a thinking-only response (provider put everything into
  // reasoning_content) from a genuinely empty choice (finish_reason=length on
  // a bad max_tokens, or the provider returned nothing at all).
  logger.warn('DashScope chat returned an empty reply', {
    component: 'Esp32AiTranscribeChat',
    model: input.model,
    finish_reason: input.finishReason,
    reasoning_bytes: input.reasoningBytes,
    content_bytes: input.contentBytes,
    tool_rounds: input.toolRounds,
    transcript_bytes: input.transcriptBytes,
    request_id: input.requestId,
  });
}

async function fetchStreamingCompletion(
  config: ChatStreamConfig,
  messages: Array<Record<string, unknown>>,
  hasTools: boolean,
  pusher: PipelinePusher
): Promise<{
  requestId: string | null;
  content: string | null;
  finishReason: string | null;
  reasoningBytes: number;
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
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
      temperature: 0.3,
      tools: hasTools ? AI_TOOLS : undefined,
      tool_choice: hasTools ? 'auto' : undefined,
    };
    if (typeof config.enableThinking === 'boolean') {
      body.enable_thinking = config.enableThinking;
    }
    if (config.enableThinking !== false && config.thinkingBudget) {
      body.thinking_budget = config.thinkingBudget;
    }
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
        code === 'provider_unavailable' ? 502 : r.status
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
  finishReason: string | null;
  reasoningBytes: number;
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
  let finishReason: string | null = null;
  const acc: AccumulatedToolCall[] = [];
  let firstDeltaEmitted = false;
  let reasoningStarted = false;
  let reasoningDone = false;
  let reasoning = '';
  function finishReasoning(): void {
    if (reasoningStarted && !reasoningDone) {
      pusher.emitThinkingDone(reasoning);
      reasoningDone = true;
    }
  }
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
    if (
      typeof delta.reasoning_content === 'string' &&
      delta.reasoning_content.length > 0
    ) {
      if (!reasoningStarted) {
        pusher.emitThinkingStart();
        reasoningStarted = true;
      }
      reasoning += delta.reasoning_content;
      pusher.emitThinkingDelta(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      finishReasoning();
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
      finishReason = choice.finish_reason;
      finishReasoning();
      if (firstDeltaEmitted) pusher.closeSentence();
    }
  }
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let nextEvent;
    while ((nextEvent = takeNextSseEvent(buf)) !== null) {
      handleEvent(nextEvent.event);
      buf = nextEvent.rest;
    }
  }
  finishReasoning();
  return {
    requestId,
    content: content || null,
    finishReason,
    reasoningBytes: Buffer.byteLength(reasoning, 'utf8'),
    toolCalls: hasTools ? sealToolCalls(acc) : [],
  };
}

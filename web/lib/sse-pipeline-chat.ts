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
  type StreamingPipelineInput,
} from './sse-pipeline-types';
import { takeNextSseEvent } from './sse-events';
import { AI_TOOLS, STD_AI_TOOLS } from './ai-tools/voice-tools';
import { findCatalogTool } from './mcp/tool-catalog';
import {
  createVoiceOperation,
  throwIfVoiceStopped,
  waitForVoiceOperation,
  cancelVoiceReaderOnAbort,
  VoiceOperationStopped,
} from './voice-operation';

export interface ChatStreamConfig {
  interactive?: boolean;
  signal?: AbortSignal;
  remainingMs?: () => number;
  apiKey: string;
  baseUrl: string;
  model: string;
  llmTimeoutMs: number;
  systemPrompt: string;
  enableThinking?: boolean;
  reasoningEffort?: StreamingPipelineInput['reasoningEffort'];
  thinkingBudget?: number;
}

function isStep5PreviewModel(model: string): boolean {
  return /^(?:stepfun\/)?step-5-preview$/i.test(model);
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
    rawArgs: string,
    meta?: {
      callId: string;
      requestId?: string;
      signal?: AbortSignal;
      writeSignal?: AbortSignal;
    }
  ): Promise<{
    ok: boolean;
    stop?: boolean;
    display: string;
    data?: unknown;
    action?: unknown;
    error?: { code: string; message: string; retryable?: boolean };
  }>;
}

export async function runPipelineChat(
  config: ChatStreamConfig,
  input: ChatStreamInput,
  pusher: PipelinePusher,
  toolExecutor?: ToolExecutor
): Promise<ChatStreamResult> {
  const operation = createVoiceOperation(config.llmTimeoutMs, config.signal);
  try {
    throwIfVoiceStopped(operation.signal);
    return await runChatWithinBudget(
      {
        ...config,
        signal: operation.signal,
        remainingMs: operation.remainingMs,
      },
      input,
      pusher,
      toolExecutor
    );
  } catch (error) {
    throwIfVoiceStopped(
      operation.signal,
      () =>
        new Esp32AiProviderError('chat_timeout', 'Chat deadline exceeded', 504)
    );
    throw error;
  } finally {
    operation.dispose();
  }
}

async function runChatWithinBudget(
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
    ? await waitForVoiceOperation(
        loadTurns(input.userId, conversationId, config.signal),
        config.signal
      )
    : [];

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: config.systemPrompt },
  ];
  for (const turn of contextTurnsForLlm(priorTurns)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: input.transcript });

  const fallbackNotice =
    isStep5PreviewModel(config.model) && config.enableThinking === false
      ? `该模型不支持关闭 thinking，当前使用 ${config.model} low 回答。\n\n`
      : '';
  let lastRequestId: string | null = null;
  let fullReply = '';
  let lastFinishReason: string | null = null;
  let lastReasoningBytes = 0;
  const allActions: unknown[] = [];
  const functionCalls: ChatStreamResult['functionCalls'] = [];

  // Four tool rounds plus one narration-only round. A successful final write
  // must not be discarded as "tool loop exceeded" before its receipt is read.
  for (let round = 0; round <= 4; round += 1) {
    throwIfVoiceStopped(config.signal);
    const hasTools = Boolean(toolExecutor) && round < 4;
    if (round === 4)
      messages.push({
        role: 'system',
        content:
          '本轮工具调用已达上限。请根据已有工具回执说明结果和未完成部分；没有成功回执的写入不能说已保存。不要继续调用工具。',
      });
    const response = await fetchStreamingCompletion(
      config,
      messages,
      hasTools,
      pusher,
      fullReply ? '' : fallbackNotice
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
        await waitForVoiceOperation(
          appendTurns(
            input.userId,
            conversationId,
            input.tier || 'std',
            input.deviceId ?? null,
            [
              { role: 'user', content: input.transcript, created_at: now },
              { role: 'assistant', content: fullReply, created_at: now },
            ],
            config.signal
          ),
          config.signal
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
      throwIfVoiceStopped(config.signal);
      pusher.emitToolStart(
        call.id,
        call.function.name,
        response.toolCalls.indexOf(call)
      );
      throwIfVoiceStopped(config.signal);
      const t0 = Date.now();
      let result: Awaited<ReturnType<ToolExecutor>>;
      const readOnly =
        call.function.name === 'ask_question' ||
        findCatalogTool(call.function.name)?.annotations?.readOnlyHint === true;
      // Disconnect cannot cancel a started write's receipt. Its independent
      // finalization signal still expires at the original turn deadline.
      const writeOperation = readOnly
        ? undefined
        : createVoiceOperation(config.remainingMs?.() ?? config.llmTimeoutMs);
      let workStarted = false;
      let stoppedAt: number | undefined;
      const observeStop = () => {
        stoppedAt = performance.now();
      };
      config.signal?.addEventListener('abort', observeStop, { once: true });
      try {
        throwIfVoiceStopped(writeOperation?.signal);
        workStarted = true;
        const work = toolExecutor
          ? toolExecutor(call.function.name, call.function.arguments, {
              callId: call.id,
              signal: config.signal,
              ...(!readOnly ? { writeSignal: writeOperation?.signal } : {}),
            })
          : Promise.resolve({
              ok: false,
              display: 'No tool executor registered',
            });
        result = await waitForVoiceOperation(
          work,
          readOnly ? config.signal : writeOperation?.signal
        );
      } catch (err) {
        if (readOnly && config.signal?.aborted) throw err;
        if (writeOperation?.signal.aborted && !workStarted) throw err;
        result = {
          ok: false,
          display: writeOperation?.signal.aborted
            ? 'Write result pending confirmation'
            : err instanceof Error
              ? err.message
              : 'tool failed',
          ...(writeOperation?.signal.aborted
            ? {
                data: { tool_call_id: call.id, outcome: 'unknown_outcome' },
                error: {
                  code: 'unknown_outcome',
                  message:
                    'Original write requires confirmation; do not create another operation.',
                  retryable: true,
                },
              }
            : {}),
        };
      } finally {
        writeOperation?.dispose();
        config.signal?.removeEventListener('abort', observeStop);
        if (stoppedAt !== undefined)
          logger.info('ESP32 voice tool settled after stop', {
            component: 'Esp32AiTranscribeChat',
            call_id: call.id,
            read_only: readOnly,
            elapsed_after_stop_ms: Math.round(performance.now() - stoppedAt),
          });
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
        ...(result.error
          ? {
              error_code: /^[a-z][a-z0-9_]{0,79}$/.test(result.error.code)
                ? result.error.code
                : 'tool_execution_failed',
            }
          : {}),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
      if (
        config.signal?.aborted ||
        result.stop ||
        result.error?.code === 'user_cancelled'
      ) {
        // Do not detach an executing write or start another tool/LLM round.
        // The executor's request ledger and this exact receipt remain valid.
        const replyText = functionCalls.map(call => call.display).join('\n');
        if (input.userId) {
          const now = new Date().toISOString();
          await appendTurns(
            input.userId,
            conversationId,
            input.tier || 'std',
            input.deviceId ?? null,
            [
              { role: 'user', content: input.transcript, created_at: now },
              { role: 'assistant', content: replyText, created_at: now },
            ],
            config.signal
          );
        }
        pusher.emitStage('turn_stopped_after_tools', {
          completed_tool_calls: functionCalls.length,
          remaining_tool_calls:
            response.toolCalls.length - response.toolCalls.indexOf(call) - 1,
        });
        return {
          replyText,
          conversationId,
          requestId: lastRequestId,
          model: config.model,
          finishReason:
            config.signal?.reason instanceof VoiceOperationStopped
              ? config.signal.reason.reason
              : 'cancelled',
          reasoningBytes: lastReasoningBytes,
          actions: allActions,
          functionCalls,
        };
      }
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
  pusher: PipelinePusher,
  replyPrefix: string
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
  const operation = createVoiceOperation(config.llmTimeoutMs, config.signal);
  try {
    throwIfVoiceStopped(operation.signal);
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
      temperature: 0.3,
      tools: hasTools
        ? config.interactive
          ? STD_AI_TOOLS
          : AI_TOOLS
        : undefined,
      tool_choice: hasTools ? 'auto' : undefined,
    };
    if (isStep5PreviewModel(config.model)) {
      // Step 5 uses reasoning_effort, not DashScope's thinking controls.
      // https://platform.stepfun.com/docs/zh/guides/models/step-5-preview
      const effort =
        config.enableThinking === false ? 'low' : config.reasoningEffort;
      if (effort) {
        body.reasoning_effort = effort;
      }
    } else {
      if (typeof config.enableThinking === 'boolean') {
        body.enable_thinking = config.enableThinking;
      }
      if (config.enableThinking !== false && config.thinkingBudget) {
        body.thinking_budget = config.thinkingBudget;
      }
    }
    const r = await waitForVoiceOperation(
      fetch(config.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.apiKey,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: operation.signal,
      }),
      operation.signal
    );
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
    return await consumeOpenAiSse(
      r.body,
      pusher,
      hasTools,
      replyPrefix,
      operation.signal
    );
  } finally {
    operation.dispose();
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
  hasTools: boolean,
  replyPrefix: string,
  signal?: AbortSignal
): Promise<ConsumedStream> {
  const reader = body.getReader();
  const releaseReader = cancelVoiceReaderOnAbort(reader, signal);
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
    // StepFun defaults to `reasoning`; DeepSeek/DashScope use
    // `reasoning_content`. Keep either field on the thinking channel.
    const reasoningDelta = delta.reasoning_content || delta.reasoning;
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      if (!reasoningStarted) {
        pusher.emitThinkingStart();
        reasoningStarted = true;
      }
      reasoning += reasoningDelta;
      pusher.emitThinkingDelta(reasoningDelta);
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      finishReasoning();
      if (!firstDeltaEmitted) {
        pusher.openSentence();
        // Add the fallback notice only with actual answer content, so a
        // reasoning-only/empty upstream cannot become a notice-only reply.
        if (replyPrefix) {
          pusher.appendDelta(replyPrefix);
          content += replyPrefix;
        }
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
  try {
    while (true) {
      const chunk = await waitForVoiceOperation(reader.read(), signal);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nextEvent;
      while ((nextEvent = takeNextSseEvent(buf)) !== null) {
        handleEvent(nextEvent.event);
        buf = nextEvent.rest;
      }
    }
  } finally {
    releaseReader();
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

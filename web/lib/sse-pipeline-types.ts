// sse-pipeline-types.ts
// Shared types and the PipelinePusher helper for the v2 SSE pipeline.

import type { SseWriter } from './ai-stream';
import { SseEventIdGenerator } from './ai-stream';
import type { Esp32AiErrorCode } from './ai-errors';
import type {
  Esp32AiFunctionCallSummary,
  Esp32AiStatusTraceItem,
} from './esp32-ai-provider';

export interface StreamingPipelineInput {
  audio: ArrayBuffer;
  sampleRate: number;
  channels: number;
  sampleFormat: 's16le';
  conversationId?: string | null;
  tier?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  enableThinking?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface StreamingPipelineResult {
  turnId: string;
  conversationId: string;
  latencyMs: number;
  transcript: string;
  replyText: string;
  actions: unknown[];
  functionCalls: Esp32AiFunctionCallSummary[];
  statusTrace: Esp32AiStatusTraceItem[];
}

export interface StreamingToolContext {
  userId: string;
  conversationId?: string | null;
  deviceId?: string | null;
  supabase: unknown;
}

export interface OaiChatChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: 'assistant' | 'user' | 'system' | 'tool';
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
      reasoning_content?: string | null;
    };
    finish_reason?: string | 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage?: unknown;
}

export interface AccumulatedToolCall {
  id: string | null;
  name: string;
  argumentsText: string;
  index: number;
}

export function applyToolCallDelta(
  acc: AccumulatedToolCall[],
  deltas: NonNullable<
    NonNullable<OaiChatChunk['choices']>[number]['delta']
  >['tool_calls']
): void {
  if (!deltas) return;
  for (const delta of deltas) {
    const idx = typeof delta.index === 'number' ? delta.index : acc.length;
    let slot = acc[idx];
    if (!slot) {
      slot = { id: null, name: '', argumentsText: '', index: idx };
      acc[idx] = slot;
    }
    if (delta.id) slot.id = delta.id;
    if (delta.function?.name) slot.name += delta.function.name;
    if (typeof delta.function?.arguments === 'string') {
      slot.argumentsText += delta.function.arguments;
    }
  }
}

export function sealToolCalls(acc: AccumulatedToolCall[]): Array<{
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  return acc
    .filter(function (slot) {
      return slot.name;
    })
    .map(function (slot) {
      return {
        id: slot.id || 'tool-' + slot.index,
        type: 'function' as const,
        function: { name: slot.name, arguments: slot.argumentsText },
      };
    });
}

export class PipelinePusher {
  private nextSentenceId = 0;
  private currentSentenceId: string | null = null;
  private currentSentenceText = '';
  private lastAsrPollEmitMs = 0;
  private asrStageValue: 'pending' | 'succeeded' | 'failed' = 'pending';

  constructor(
    private readonly writer: SseWriter,
    private readonly idGen: SseEventIdGenerator,
    private readonly startedAt: number
  ) {}

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  emitReady(event: {
    turn_id: string;
    conversation_id: string | null;
    ai_tier: 'std' | 'pro';
    started_at_ms: number;
  }): void {
    this.writer.emit('ready', event);
  }

  emitStage(stage: string, detail?: Record<string, unknown>): void {
    // Detail object is allowed to carry elapsed_ms for callers that want to
    // emit a single record. We don't synthesize a default; the sse writer
    // populates elapsed_ms at flush time when absent.
    this.writer.emit('stage', { stage, ...(detail ?? {}) });
  }

  emitAsrDelta(delta: string): void {
    this.asrStageValue = 'pending';
    this.writer.emit('asr.delta', {
      delta: delta,
      elapsed_ms: this.elapsedMs(),
    });
  }

  emitAsrComplete(
    text: string,
    asrModel: string,
    provider: 'dashscope' | 'stepfun' = 'dashscope'
  ): void {
    this.asrStageValue = 'succeeded';
    this.writer.emit('asr.complete', {
      text,
      elapsed_ms: this.elapsedMs(),
      asr: { provider, model: asrModel },
    });
  }

  emitAsrFailed(
    error_code: Esp32AiErrorCode,
    stage: string,
    message: string
  ): void {
    this.asrStageValue = 'failed';
    this.writer.emit('asr.failed', { error_code, stage, message });
  }

  emitThinkingStart(): void {
    this.writer.emit('thinking.start', {});
  }

  emitThinkingDelta(delta: string): void {
    this.writer.emit('thinking.delta', {
      delta,
      elapsed_ms: this.elapsedMs(),
    });
  }

  emitThinkingDone(fullText: string): void {
    this.writer.emit('thinking.done', {
      full_text: fullText,
      elapsed_ms: this.elapsedMs(),
    });
  }

  openSentence(): string {
    this.currentSentenceId =
      's-' + (this.nextSentenceId++).toString().padStart(3, '0');
    this.currentSentenceText = '';
    this.writer.emit('text.start', {
      sentence_id: this.currentSentenceId,
      role: 'assistant',
    });
    return this.currentSentenceId;
  }

  appendDelta(delta: string): void {
    if (!this.currentSentenceId) this.openSentence();
    this.currentSentenceText += delta;
    this.writer.emit('text.delta', {
      sentence_id: this.currentSentenceId,
      delta,
      elapsed_ms: this.elapsedMs(),
    });
  }

  closeSentence(): void {
    if (!this.currentSentenceId) return;
    this.writer.emit('text.end', {
      sentence_id: this.currentSentenceId,
      full_text: this.currentSentenceText,
      elapsed_ms: this.elapsedMs(),
    });
    this.currentSentenceId = null;
    this.currentSentenceText = '';
  }

  emitToolStart(
    tool_call_id: string,
    name: string,
    index: number,
    args?: Record<string, unknown>
  ): void {
    const payload: {
      tool_call_id: string;
      name: string;
      index: number;
      args?: Record<string, unknown>;
    } = { tool_call_id, name, index };
    if (args) payload.args = args;
    this.writer.emit('tool.start', payload);
  }

  emitToolResult(event: {
    tool_call_id: string;
    name: string;
    ok: boolean;
    display: string;
    elapsed_ms?: number;
    items_count?: number;
    error_code?: string;
    message?: string;
  }): void {
    this.writer.emit('tool.result', event);
  }

  emitFinal(event: {
    success: true;
    conversation_id: string | null;
    latency_ms: number;
    transcript: string;
    reply_text: string;
    actions: unknown[];
    function_calls: Esp32AiFunctionCallSummary[];
    status_trace: Esp32AiStatusTraceItem[];
  }): void {
    this.writer.emit('final', event);
  }

  asrStatus(): 'pending' | 'succeeded' | 'failed' {
    return this.asrStageValue;
  }

  shouldEmitAsrPoll(now: number): boolean {
    if (now - this.lastAsrPollEmitMs >= 5000) {
      this.lastAsrPollEmitMs = now;
      return true;
    }
    return false;
  }
}

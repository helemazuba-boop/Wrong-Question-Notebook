// sse-pipeline-types.ts
// Shared types and the PipelinePusher helper for the v2 SSE pipeline.

import { createHash } from 'node:crypto';
import type { SseWriter } from './ai-stream';
import { SseEventIdGenerator } from './ai-stream';
import type { Esp32AiErrorCode } from './ai-errors';
import type {
  Esp32AiFunctionCallSummary,
  Esp32AiStatusTraceItem,
} from './esp32-ai-provider';

export interface StreamingPipelineInput {
  audio: ArrayBuffer;
  confirmedText?: string;
  interactive?: boolean;
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
      reasoning?: string | null;
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

// Leave headroom for event/id/data framing under the firmware's 16 KiB limit.
const DEVICE_JSON_BUDGET = 12 * 1024;
const payloadBytes = (data: unknown): number =>
  Buffer.byteLength(JSON.stringify(data), 'utf8');

class StreamedTextDigest {
  private hash = createHash('sha256');
  private bytes = 0;
  append(text: string): void {
    this.hash.update(text, 'utf8');
    this.bytes += Buffer.byteLength(text, 'utf8');
  }
  matches(text: string): boolean {
    return (
      this.bytes === Buffer.byteLength(text, 'utf8') &&
      this.hash.copy().digest('hex') ===
        createHash('sha256').update(text, 'utf8').digest('hex')
    );
  }
}

export class PipelinePusher {
  private thinkingDigest = new StreamedTextDigest();
  private readonly answerDigest = new StreamedTextDigest();
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

  private emit(event: string, data: unknown): void {
    // Never truncate receipts, interactions or an unstreamed authoritative final.
    if (payloadBytes(data) > DEVICE_JSON_BUDGET) {
      throw new Error(`Device SSE payload exceeds budget: ${event}`);
    }
    this.writer.emit(event, data);
  }

  private emitDelta(
    event: string,
    delta: string,
    fields: Record<string, unknown>
  ): void {
    const base = payloadBytes({ ...fields, delta: '' });
    let part = '';
    let bytes = base;
    for (const character of delta) {
      // Account for JSON escaping as well as multibyte UTF-8 characters.
      const cost = payloadBytes(character) - 2;
      if (bytes + cost > DEVICE_JSON_BUDGET && part) {
        this.emit(event, { ...fields, delta: part });
        part = '';
        bytes = base;
      }
      part += character;
      bytes += cost;
    }
    this.emit(event, { ...fields, delta: part });
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  emitReady(event: {
    turn_id: string;
    conversation_id: string | null;
    ai_tier: 'std' | 'pro' | 'agent';
    started_at_ms: number;
  }): void {
    this.emit('ready', event);
  }

  emitStage(stage: string, detail?: Record<string, unknown>): void {
    // Detail object is allowed to carry elapsed_ms for callers that want to
    // emit a single record. We don't synthesize a default; the sse writer
    // populates elapsed_ms at flush time when absent.
    this.emit('stage', { stage, ...(detail ?? {}) });
  }

  emitAsrDelta(delta: string): void {
    this.asrStageValue = 'pending';
    this.emit('asr.delta', {
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
    this.emit('asr.complete', {
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
    this.emit('asr.failed', { error_code, stage, message });
  }

  emitThinkingStart(): void {
    this.thinkingDigest = new StreamedTextDigest();
    this.emit('thinking.start', {});
  }

  emitThinkingDelta(delta: string): void {
    this.emitDelta('thinking.delta', delta, { elapsed_ms: this.elapsedMs() });
    this.thinkingDigest.append(delta);
  }

  emitThinkingDone(fullText: string): void {
    const payload = { full_text: fullText, elapsed_ms: this.elapsedMs() };
    if (
      payloadBytes(payload) > DEVICE_JSON_BUDGET &&
      this.thinkingDigest.matches(fullText)
    ) {
      payload.full_text = ''; // Already delivered, so the device keeps its accumulated preview.
    }
    this.emit('thinking.done', payload);
  }

  openSentence(): string {
    this.currentSentenceId =
      's-' + (this.nextSentenceId++).toString().padStart(3, '0');
    this.currentSentenceText = '';
    this.emit('text.start', {
      sentence_id: this.currentSentenceId,
      role: 'assistant',
    });
    return this.currentSentenceId;
  }

  appendDelta(delta: string): void {
    if (!this.currentSentenceId) this.openSentence();
    this.currentSentenceText += delta;
    this.emitDelta('text.delta', delta, {
      sentence_id: this.currentSentenceId,
      elapsed_ms: this.elapsedMs(),
    });
    this.answerDigest.append(delta);
  }

  closeSentence(): void {
    if (!this.currentSentenceId) return;
    const payload = {
      sentence_id: this.currentSentenceId,
      full_text: this.currentSentenceText,
      elapsed_ms: this.elapsedMs(),
    };
    if (payloadBytes(payload) > DEVICE_JSON_BUDGET) payload.full_text = '';
    this.emit('text.end', payload);
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
    this.emit('tool.start', payload);
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
    this.emit('tool.result', event);
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
    let payload = event;
    if (
      payloadBytes(payload) > DEVICE_JSON_BUDGET &&
      this.answerDigest.matches(event.reply_text)
    ) {
      payload = { ...event, reply_text: '' };
    }
    this.emit('final', payload);
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

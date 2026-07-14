// sse-pipeline.ts
// Top-level v2-streaming SSE orchestrator. Called by the v2 branch of
// `app/api/esp32/ai/transcribe-chat/route.ts`. Drives:
//   ready -> stage(audio_received) -> stage(asr_started)
//   asr.delta* -> asr.complete -> stage(chat_started)
//   text.start -> text.delta* -> (tool.start -> tool.result)* -> text.end
//   -> stage(chat_done) -> final
// On failure emits `asr.failed` then `error` and closes the stream.

import { randomUUID } from 'node:crypto';

import type { SseWriter } from './ai-stream';
import { SseEventIdGenerator } from './ai-stream';
import { closeSseWithError, type Esp32AiErrorCode } from './ai-errors';
import { Esp32AiProviderError } from './esp32-ai-provider';
import { runPipelineAsr } from './sse-pipeline-asr';
import { runPipelineChat, type ToolExecutor } from './sse-pipeline-chat';
import {
  PipelinePusher,
  type StreamingPipelineInput,
  type StreamingPipelineResult,
} from './sse-pipeline-types';

export interface RunStreamingPipelineOptions {
  writer: SseWriter;
  input: StreamingPipelineInput;
  asrModel: string;
  chatModelStd: string;
  chatModelPro: string;
  openAiBaseUrlStd: string;
  openAiBaseUrlPro: string;
  dashScopeApiKey: string;
  chatApiKeyStd: string;
  chatApiKeyPro: string;
  asrTaskUrl: string;
  asrTaskStatusBaseUrl: string;
  asrLanguageHints: string[];
  asrTimeoutMs: number;
  asrPollIntervalMs: number;
  asrPollAttempts: number;
  llmTimeoutMs: number;
  audioUrlTtlMs: number;
  publicBaseUrl: string;
  systemPrompt: string;
  toolExecutor?: ToolExecutor;
}

export async function runStreamingPipeline(
  options: RunStreamingPipelineOptions
): Promise<StreamingPipelineResult> {
  const startedAt = Date.now();
  const idGen = new SseEventIdGenerator();
  const pusher = new PipelinePusher(options.writer, idGen, startedAt);

  const tier: 'std' | 'pro' = options.input.tier === 'pro' ? 'pro' : 'std';
  const turnId = randomUUID();

  pusher.emitReady({
    turn_id: turnId,
    conversation_id: options.input.conversationId || null,
    ai_tier: tier,
    started_at_ms: startedAt,
  });

  // ---- 1. ASR ----
  let asrResult: {
    transcript: string;
    requestId: string | null;
    elapsedMs: number;
  };
  try {
    asrResult = await runPipelineAsr(
      {
        dashScopeApiKey: options.dashScopeApiKey,
        asrTaskUrl: options.asrTaskUrl,
        asrTaskStatusBaseUrl: options.asrTaskStatusBaseUrl,
        asrModel: options.asrModel,
        asrLanguageHints: options.asrLanguageHints,
        asrTimeoutMs: options.asrTimeoutMs,
        asrPollIntervalMs: options.asrPollIntervalMs,
        asrPollAttempts: options.asrPollAttempts,
        audioUrlTtlMs: options.audioUrlTtlMs,
        publicBaseUrl: options.publicBaseUrl,
      },
      options.input.audio,
      options.input.sampleRate,
      options.input.channels,
      pusher
    );
  } catch (error) {
    const code: Esp32AiErrorCode =
      error instanceof Esp32AiProviderError
        ? (error.code as Esp32AiErrorCode)
        : 'asr_failed';
    pusher.emitAsrFailed(
      code,
      'asr_pipeline',
      String((error as Error)?.message || 'ASR failed')
    );
    await closeSseWithError(
      options.writer,
      code,
      String((error as Error)?.message || 'ASR failed'),
      {
        stage: 'asr_pipeline',
        latency_ms: Date.now() - startedAt,
      }
    );
    throw error;
  }
  pusher.emitAsrComplete(asrResult.transcript, options.asrModel);

  // ---- 2. Chat (streaming) ----
  const chatModel =
    tier === 'pro' ? options.chatModelPro : options.chatModelStd;
  const baseUrl =
    tier === 'pro' ? options.openAiBaseUrlPro : options.openAiBaseUrlStd;
  const apiKey = tier === 'pro' ? options.chatApiKeyPro : options.chatApiKeyStd;
  const chat = await runPipelineChat(
    {
      apiKey,
      baseUrl,
      model: chatModel,
      llmTimeoutMs: options.llmTimeoutMs,
      systemPrompt: options.systemPrompt,
    },
    {
      transcript: asrResult.transcript,
      conversationId: options.input.conversationId,
      tier: options.input.tier,
      userId: options.input.userId,
      deviceId: options.input.deviceId,
    },
    pusher,
    options.toolExecutor
  );

  const latencyMs = Date.now() - startedAt;
  pusher.emitFinal({
    success: true,
    conversation_id: chat.conversationId,
    latency_ms: latencyMs,
    transcript: asrResult.transcript,
    reply_text: chat.replyText,
    actions: chat.actions,
    function_calls: chat.functionCalls,
    status_trace: [],
  });

  return {
    turnId,
    conversationId: chat.conversationId,
    latencyMs,
    transcript: asrResult.transcript,
    replyText: chat.replyText,
    actions: chat.actions,
    functionCalls: chat.functionCalls,
    statusTrace: [],
  };
}

// streaming-handler.ts
// ASR-only SSE branch for /api/esp32/agent/transcribe?protocol=v2-streaming.
//
// The WS relay (wqn-realtime) hands the FINAL PCM buffer to this endpoint and
// forwards the returned SSE stream verbatim to the device as WS text frames.
// The wire vocabulary is the same voice-v2 one used by transcribe-chat, so the
// device reuses its transport SSE parser:
//   ready -> stage* -> asr.delta* -> asr.complete -> final
//   (failure: asr.failed -> error -> stream close)
//
// Unlike transcribe-chat there is no chat/tool/conversation stage: the
// pipeline stops right after ASR.

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { closeSseWithError, type Esp32AiErrorCode } from '@/lib/ai-errors';
import {
  createSseResponse,
  SseEventIdGenerator,
  type SseWriter,
} from '@/lib/ai-stream';
import { Esp32AiProviderError } from '@/lib/esp32-ai-provider';
import { logger } from '@/lib/logger';
import { runPipelineAsr } from '@/lib/sse-pipeline-asr';
import { PipelinePusher } from '@/lib/sse-pipeline-types';
import {
  loadV2RuntimeConfig,
  type V2RuntimeConfig,
} from '@/app/api/esp32/ai/transcribe-chat/v2-handler';

export async function handleAgentTranscribeStreaming(
  req: NextRequest,
  config?: V2RuntimeConfig
): Promise<NextResponse> {
  const resolvedConfig = config ?? loadV2RuntimeConfig();

  // The relay forwards the device turn request_id as x-wqn-request-id; the
  // device itself does not parse ready.turn_id, this is for cloud-side log
  // correlation only.
  const headerRequestId = (req.headers.get('x-wqn-request-id') || '').trim();
  const turnId = headerRequestId || randomUUID();

  const audio = await req.arrayBuffer();
  const startedAt = Date.now();

  const sse = createSseResponse(async function (writer: SseWriter) {
    const pusher = new PipelinePusher(
      writer,
      new SseEventIdGenerator(),
      startedAt
    );
    pusher.emitReady({
      turn_id: turnId,
      conversation_id: null,
      ai_tier: 'agent',
      started_at_ms: startedAt,
    });

    try {
      // runPipelineAsr emits stage + asr.delta (StepFun) only; ready /
      // asr.complete / final are the caller's responsibility here.
      const result = await runPipelineAsr(
        resolvedConfig,
        audio,
        16000,
        1,
        pusher
      );

      if (writer.isClosed()) {
        // The relay/device gave up before ASR finished (turn timeout, WS
        // drop). Without this line the turn is invisible in the logs.
        logger.warn(
          'agent transcribe streaming finished after client stream closed',
          {
            component: 'Esp32AgentTranscribe',
            elapsed_since_start_ms: Date.now() - startedAt,
          }
        );
        return;
      }

      pusher.emitAsrComplete(result.transcript, result.model, result.provider);
      pusher.emitFinal({
        success: true,
        conversation_id: null,
        latency_ms: Date.now() - startedAt,
        transcript: result.transcript,
        reply_text: '',
        actions: [],
        function_calls: [],
        status_trace: [],
      });
      logger.info('agent transcribe streaming completed', {
        component: 'Esp32AgentTranscribe',
        provider: result.provider,
        model: result.model,
        elapsed_ms: result.elapsedMs,
        transcript_bytes: Buffer.byteLength(result.transcript, 'utf8'),
      });
    } catch (error) {
      const code: Esp32AiErrorCode =
        error instanceof Esp32AiProviderError
          ? (error.code as Esp32AiErrorCode)
          : 'asr_failed';
      const message =
        error instanceof Error ? error.message : 'Agent ASR failed';
      if (code === 'no_speech') {
        // Expected outcome for a button tap or near-silence, not a failure.
        logger.warn('agent transcribe streaming: no speech in audio', {
          component: 'Esp32AgentTranscribe',
          code,
          message,
        });
      } else {
        logger.error('agent transcribe streaming failed', error, {
          component: 'Esp32AgentTranscribe',
        });
      }
      pusher.emitAsrFailed(code, 'asr_pipeline', message);
      await closeSseWithError(writer, code, message, {
        stage: 'asr_pipeline',
        latency_ms: Date.now() - startedAt,
      });
    }
  });

  return new NextResponse(sse.body, {
    status: sse.status,
    statusText: sse.statusText,
    headers: sse.headers,
  });
}

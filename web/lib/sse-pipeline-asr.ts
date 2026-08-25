// sse-pipeline-asr.ts
// Sync ASR (Paraformer-v2) wrapped so the v2 SSE pipeline can emit
// `asr.complete` and `stage(asr_*)` events. Reuses the v1 staging path
// via `stageEsp32AiAudioFile` to keep the upload-to-DashScope behavior
// identical to v1.

import { Esp32AiProviderError } from './esp32-ai-provider';
import {
  isAsrFallbackEligibleCode,
  type Esp32AiAsrProvider,
} from './esp32-ai-asr-selection';
import type { PipelinePusher } from './sse-pipeline-types';
import { runStepFunAsrSse } from './stepfun-asr';

export interface AsrResult {
  transcript: string;
  requestId: string | null;
  elapsedMs: number;
  provider: Esp32AiAsrProvider;
  model: string;
}

export interface AsrConfig {
  asrProvider: Esp32AiAsrProvider;
  asrFallbackProvider: Esp32AiAsrProvider | null;
  dashScopeApiKey: string;
  asrTaskUrl: string;
  asrTaskStatusBaseUrl: string;
  asrModel: string;
  asrLanguageHints: string[];
  asrTimeoutMs: number;
  asrPollIntervalMs: number;
  asrPollAttempts: number;
  audioUrlTtlMs: number;
  publicBaseUrl: string;
  stepfunApiKey: string;
  stepfunAsrUrl: string;
  stepfunAsrModel: string;
  stepfunAsrLanguage: string;
  stepfunAsrHotwords: string[];
  stepfunAsrEnableItn: boolean;
}

export async function runPipelineAsr(
  config: AsrConfig,
  audio: ArrayBuffer,
  sampleRate: number,
  channels: number,
  pusher: PipelinePusher
): Promise<AsrResult> {
  pusher.emitStage('batch_asr_start', {
    provider: config.asrProvider,
    sampleRate,
    byteLength: audio.byteLength,
  });
  pusher.emitStage('asr_provider_selected', {
    provider: config.asrProvider,
    role: 'primary',
  });
  try {
    return await runSinglePipelineAsr(
      config,
      config.asrProvider,
      audio,
      sampleRate,
      channels,
      pusher
    );
  } catch (error) {
    if (
      !config.asrFallbackProvider ||
      !(error instanceof Esp32AiProviderError) ||
      !isAsrFallbackEligibleCode(error.code)
    ) {
      throw error;
    }

    pusher.emitStage('asr_fallback', {
      from: config.asrProvider,
      to: config.asrFallbackProvider,
      error_code: error.code,
    });
    return runSinglePipelineAsr(
      config,
      config.asrFallbackProvider,
      audio,
      sampleRate,
      channels,
      pusher
    );
  }
}

async function runSinglePipelineAsr(
  config: AsrConfig,
  provider: Esp32AiAsrProvider,
  audio: ArrayBuffer,
  sampleRate: number,
  channels: number,
  pusher: PipelinePusher
): Promise<AsrResult> {
  if (provider === 'stepfun') {
    const result = await runStepFunAsrSse(
      {
        stepfunApiKey: config.stepfunApiKey,
        stepfunAsrUrl: config.stepfunAsrUrl,
        stepfunAsrModel: config.stepfunAsrModel,
        stepfunAsrLanguage: config.stepfunAsrLanguage,
        stepfunAsrHotwords: config.stepfunAsrHotwords,
        stepfunAsrEnableItn: config.stepfunAsrEnableItn,
        asrTimeoutMs: config.asrTimeoutMs,
      },
      audio,
      sampleRate,
      channels,
      { pusher }
    );
    return {
      ...result,
      provider,
      model: config.stepfunAsrModel,
    };
  }

  return runDashScopePipelineAsr(config, audio, sampleRate, channels, pusher);
}

async function runDashScopePipelineAsr(
  config: AsrConfig,
  audio: ArrayBuffer,
  sampleRate: number,
  channels: number,
  pusher: PipelinePusher
): Promise<AsrResult> {
  if (sampleRate !== 16000 || channels !== 1) {
    throw new Esp32AiProviderError(
      'invalid_audio',
      'Unsupported audio format for DashScope ASR provider',
      415
    );
  }

  const mod = await import('./esp32-ai-audio-staging');
  const { stageEsp32AiAudioFile, AudioStagingError } = mod;

  const startedAt = Date.now();
  pusher.emitStage('audio_received', { elapsed_ms: Date.now() - startedAt });
  pusher.emitStage('asr_started', { elapsed_ms: Date.now() - startedAt });

  let stagedAudio:
    Awaited<ReturnType<typeof stageEsp32AiAudioFile>> | undefined;
  try {
    stagedAudio = await stageEsp32AiAudioFile({
      audio,
      sampleRate,
      channels,
      publicBaseUrl: config.publicBaseUrl,
      ttlMs: config.audioUrlTtlMs,
    });

    const headers = {
      Authorization: 'Bearer ' + config.dashScopeApiKey,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    };
    const parameters: Record<string, unknown> = {};
    if (config.asrLanguageHints.length > 0) {
      parameters.language_hints = config.asrLanguageHints;
    }
    const submitResp = await fetchJsonWithTimeout<{
      request_id?: string;
      output?: { task_id?: string; task_status?: string };
    }>(
      config.asrTaskUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.asrModel,
          input: { file_urls: [stagedAudio.url] },
          parameters,
        }),
      },
      config.asrTimeoutMs,
      'asr'
    );
    const taskId = submitResp.output?.task_id;
    if (!taskId) {
      throw new Esp32AiProviderError(
        'asr_failed',
        'DashScope ASR submit missing task_id',
        500
      );
    }

    for (let attempt = 0; attempt < config.asrPollAttempts; attempt += 1) {
      if (attempt > 0) await sleep(config.asrPollIntervalMs);
      if (pusher.shouldEmitAsrPoll(Date.now())) {
        pusher.emitStage('asr_polling', {
          elapsed_ms: Date.now() - startedAt,
          attempt: attempt + 1,
          progress: Math.round((attempt / config.asrPollAttempts) * 100),
        });
      }
      const poll = await fetchJsonWithTimeout<{
        output?: {
          task_status?: string;
          code?: string;
          message?: string;
          text?: string;
          transcription_url?: string;
          results?: Array<{ text?: string }>;
        };
      }>(
        config.asrTaskStatusBaseUrl + '/' + encodeURIComponent(taskId),
        {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + config.dashScopeApiKey },
        },
        config.asrTimeoutMs,
        'asr'
      );
      const status = (poll.output?.task_status || '').toUpperCase();
      if (status === 'SUCCEEDED') {
        let transcript = poll.output?.text || '';
        if (!transcript && poll.output?.transcription_url) {
          try {
            const r = await fetchJsonWithTimeout<unknown>(
              poll.output.transcription_url,
              { method: 'GET' },
              config.asrTimeoutMs,
              'asr'
            );
            transcript = extractTranscriptFromUnknown(r);
          } catch {
            // fall through
          }
        }
        if (!transcript && Array.isArray(poll.output?.results)) {
          transcript = poll
            .output!.results!.map(function (r) {
              return r.text || '';
            })
            .filter(Boolean)
            .join('');
        }
        if (!transcript) {
          throw new Esp32AiProviderError(
            'asr_failed',
            'DashScope ASR returned no transcript',
            500
          );
        }
        const elapsedMs = Date.now() - startedAt;
        pusher.emitStage('asr_done', {
          elapsed_ms: elapsedMs,
          text_bytes: Buffer.byteLength(transcript, 'utf8'),
        });
        return {
          transcript,
          requestId: submitResp.request_id || taskId,
          elapsedMs,
          provider: 'dashscope',
          model: config.asrModel,
        };
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        const code = String(poll.output?.code || '').toLowerCase();
        const message = String(poll.output?.message || '').toLowerCase();
        if (
          code.indexOf('no_speech') >= 0 ||
          code.indexOf('success_with_no_valid_fragment') >= 0 ||
          code.indexOf('no_valid_fragment') >= 0 ||
          message.indexOf('no speech') >= 0 ||
          message.indexOf('silence') >= 0
        ) {
          throw new Esp32AiProviderError(
            'no_speech',
            'DashScope ASR detected no speech',
            422
          );
        }
        throw new Esp32AiProviderError(
          'asr_failed',
          'DashScope ASR task failed (' +
            status +
            ' ' +
            (poll.output?.code || '') +
            ')',
          500
        );
      }
    }
    throw new Esp32AiProviderError(
      'asr_timeout',
      'DashScope ASR task timed out',
      504
    );
  } catch (error) {
    if (error instanceof AudioStagingError) {
      throw new Esp32AiProviderError(
        error.code === 'disabled' ? 'disabled' : 'asr_failed',
        error.message,
        error.status
      );
    }
    throw error;
  } finally {
    await stagedAudio?.cleanup();
  }
}

function extractTranscriptFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text.trim();
  }
  if (Array.isArray(record.transcripts)) {
    return record.transcripts
      .map(function (t) {
        return extractTranscriptFromUnknown(t);
      })
      .filter(Boolean)
      .join('')
      .trim();
  }
  if (Array.isArray(record.results)) {
    return record.results
      .map(function (t) {
        return extractTranscriptFromUnknown(t);
      })
      .filter(Boolean)
      .join('')
      .trim();
  }
  return '';
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  stage: 'asr' | 'chat'
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);
  try {
    const r = await fetch(
      url,
      Object.assign({}, init, { signal: controller.signal })
    );
    if (!r.ok) {
      const code =
        r.status === 429
          ? 'rate_limited'
          : r.status >= 500
            ? 'provider_unavailable'
            : stage === 'asr'
              ? 'asr_failed'
              : 'model_failed';
      throw new Esp32AiProviderError(
        code,
        'Upstream ' + stage + ' HTTP ' + r.status,
        code === 'provider_unavailable' ? 502 : r.status
      );
    }
    return (await r.json()) as T;
  } catch (error) {
    if (error instanceof Esp32AiProviderError) throw error;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new Esp32AiProviderError(
      isAbort
        ? stage === 'asr'
          ? 'asr_timeout'
          : 'chat_timeout'
        : 'provider_unavailable',
      isAbort ? stage + ' request timed out' : stage + ' request failed',
      isAbort ? 504 : 502
    );
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

// stepfun-asr.ts
// StepFun 2.5 ASR (stepaudio-2.5-asr) via HTTP + SSE.
// One-shot POST with base64-embedded PCM, server streams transcript.text.delta
// then transcript.text.done. Unlike the DashScope path we do NOT stage the
// audio to a URL - StepFun wants the audio inline as base64.

import { Esp32AiProviderError } from './esp32-ai-provider';
import { analyzePcmS16le } from './esp32-ai-audio-staging';
import type { PipelinePusher } from './sse-pipeline-types';
import { extractSseData, takeNextSseEvent } from './sse-events';
import { logger } from './logger';

export interface StepFunAsrConfig {
  stepfunApiKey: string;
  stepfunAsrUrl: string;
  stepfunAsrModel: string;
  stepfunAsrLanguage: string;
  stepfunAsrHotwords: string[];
  stepfunAsrEnableItn: boolean;
  asrTimeoutMs: number;
}

interface StepFunAsrEvent {
  type?: string;
  delta?: string;
  text?: string;
  message?: string;
  meta?: { session_id?: string };
}

// Below these limits the clip is a button tap, a bump or near-silence rather
// than an utterance, so an empty transcript is expected and must not be
// reported as a provider failure (500). Device captures are pcm_s16le 16kHz
// mono, so 2 bytes per sample.
const NON_SPEECH_MIN_DURATION_MS = 1500;
const NON_SPEECH_MAX_RMS = 200;

export function isLikelyNonSpeechPcm(audio: ArrayBuffer): boolean {
  const sampleCount = Math.floor(audio.byteLength / 2);
  if (sampleCount === 0) return true;
  const durationMs = (sampleCount / 16000) * 1000;
  if (durationMs < NON_SPEECH_MIN_DURATION_MS) return true;

  const view = new DataView(audio);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms < NON_SPEECH_MAX_RMS;
}

export async function runStepFunAsrSse(
  config: StepFunAsrConfig,
  audio: ArrayBuffer,
  sampleRate: number,
  channels: number,
  opts?: { pusher?: PipelinePusher }
): Promise<{
  transcript: string;
  requestId: string | null;
  elapsedMs: number;
}> {
  if (sampleRate !== 16000 || channels !== 1) {
    throw new Esp32AiProviderError(
      'invalid_audio',
      'Unsupported audio format for StepFun ASR (require pcm_s16le 16kHz mono)',
      415
    );
  }

  const startedAt = Date.now();
  const pusher = opts?.pusher;
  pusher?.emitStage('audio_received', { elapsed_ms: Date.now() - startedAt });
  pusher?.emitStage('asr_started', { elapsed_ms: Date.now() - startedAt });

  const base64 = Buffer.from(audio).toString('base64');
  const requestBody = {
    audio: {
      data: base64,
      input: {
        transcription: {
          language: config.stepfunAsrLanguage,
          model: config.stepfunAsrModel,
          enable_itn: config.stepfunAsrEnableItn,
          enable_timestamp: false,
          ...(config.stepfunAsrHotwords.length > 0
            ? { hotwords: config.stepfunAsrHotwords }
            : {}),
        },
        format: {
          type: 'pcm',
          codec: 'pcm_s16le',
          rate: sampleRate,
          bits: 16,
          channel: channels,
        },
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.asrTimeoutMs);

  let response: Response;
  try {
    response = await fetch(config.stepfunAsrUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + config.stepfunApiKey,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new Esp32AiProviderError(
      isAbort ? 'asr_timeout' : 'provider_unavailable',
      isAbort ? 'StepFun ASR request timed out' : 'StepFun ASR request failed',
      isAbort ? 504 : 502
    );
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer);
    const code =
      response.status === 429
        ? 'rate_limited'
        : response.status >= 500
          ? 'provider_unavailable'
          : 'asr_failed';
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      // ignore body read failure
    }
    throw new Esp32AiProviderError(
      code,
      'StepFun ASR HTTP ' +
        response.status +
        (detail ? ' ' + detail.slice(0, 200) : ''),
      code === 'provider_unavailable' ? 502 : response.status
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let transcript = '';
  let requestId: string | null = null;

  // Event ledger for empty-transcript diagnosis. The provider protocol has
  // exactly three event types (delta/done/error); anything else, any
  // non-JSON payload, and any non-SSE 200 body currently vanish silently
  // below, so empty failures were indistinguishable from "server decided
  // there is no speech" vs "stream broke before saying anything".
  let deltaCount = 0;
  let doneCount = 0;
  let doneTextLength = 0;
  let errorEventCount = 0;
  let noDataEventCount = 0;
  let malformedEventCount = 0;
  let unknownEventCount = 0;
  let lastUnknownType = '';
  let unknownPayloadSample = '';
  let malformedPayloadSample = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nextEvent;
      while ((nextEvent = takeNextSseEvent(buffer)) !== null) {
        const rawEvent = nextEvent.event;
        buffer = nextEvent.rest;
        const dataPayload = extractSseData(rawEvent);
        if (!dataPayload) {
          noDataEventCount += 1;
          continue;
        }
        let json: StepFunAsrEvent;
        try {
          json = JSON.parse(dataPayload) as StepFunAsrEvent;
        } catch {
          malformedEventCount += 1;
          if (!malformedPayloadSample) {
            malformedPayloadSample = dataPayload.slice(0, 200);
          }
          continue;
        }
        const type = json.type;
        if (type === 'transcript.text.delta') {
          deltaCount += 1;
          const delta = typeof json.delta === 'string' ? json.delta : '';
          if (delta) {
            transcript += delta;
            pusher?.emitAsrDelta(delta);
          }
        } else if (type === 'transcript.text.done') {
          doneCount += 1;
          if (typeof json.text === 'string' && json.text) {
            transcript = json.text;
            doneTextLength = json.text.length;
          }
          if (json.meta?.session_id) {
            requestId = String(json.meta.session_id);
          }
        } else if (type === 'error') {
          errorEventCount += 1;
          const message = String(json.message || 'StepFun ASR error');
          clearTimeout(timer);
          if (isNoSpeechMessage(message)) {
            throw new Esp32AiProviderError('no_speech', message, 422);
          }
          throw new Esp32AiProviderError('asr_failed', message, 500);
        } else {
          unknownEventCount += 1;
          lastUnknownType = type || '(missing type)';
          if (!unknownPayloadSample) {
            unknownPayloadSample = dataPayload.slice(0, 200);
          }
        }
      }
    }
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Esp32AiProviderError) throw error;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new Esp32AiProviderError(
      isAbort ? 'asr_timeout' : 'asr_failed',
      isAbort ? 'StepFun ASR stream timed out' : 'StepFun ASR stream failed',
      isAbort ? 504 : 500
    );
  }
  clearTimeout(timer);

  if (!transcript) {
    // Full evidence dump for the empty-transcript path: event ledger plus
    // PCM quality stats (DC offset / clipping are the device-side suspects
    // for provider-side "no speech" verdicts). Keeps base message greppable.
    const audioDiagnostics = analyzePcmS16le(audio, sampleRate, channels);
    const events = {
      deltaCount,
      doneCount,
      doneTextLength,
      errorEventCount,
      unknownEventCount,
      malformedEventCount,
      noDataEventCount,
    };
    logger.error('StepFun ASR returned an empty transcript', undefined, {
      component: 'Esp32StepFunAsr',
      events,
      lastUnknownType: lastUnknownType || undefined,
      unknownPayloadSample: unknownPayloadSample || undefined,
      malformedPayloadSample: malformedPayloadSample || undefined,
      requestId: requestId ?? undefined,
      elapsedMs: Date.now() - startedAt,
      audio: {
        pcmBytes: audioDiagnostics.pcmBytes,
        durationMs: audioDiagnostics.sampleDurationMs,
        peak: audioDiagnostics.peak,
        rms: audioDiagnostics.rms,
        dcOffset: audioDiagnostics.dcOffset,
        clipRatio: audioDiagnostics.clipRatio,
        zeroSampleRatio: audioDiagnostics.zeroSampleRatio,
      },
    });
    if (isLikelyNonSpeechPcm(audio)) {
      throw new Esp32AiProviderError(
        'no_speech',
        'StepFun ASR returned no transcript for likely non-speech audio',
        422
      );
    }
    const eventSummary =
      `delta=${deltaCount} done=${doneCount}(${doneTextLength}chars) ` +
      `error=${errorEventCount} unknown=${unknownEventCount} ` +
      `malformed=${malformedEventCount} nodata=${noDataEventCount}`;
    throw new Esp32AiProviderError(
      'asr_failed',
      `StepFun ASR returned no transcript [events: ${eventSummary}]`,
      500
    );
  }

  const elapsedMs = Date.now() - startedAt;
  pusher?.emitStage('asr_done', {
    elapsed_ms: elapsedMs,
    text_bytes: Buffer.byteLength(transcript, 'utf8'),
  });

  return { transcript, requestId, elapsedMs };
}

function isNoSpeechMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('no_speech') ||
    lower.includes('no speech') ||
    lower.includes('silence') ||
    lower.includes('silent') ||
    lower.includes('静音') ||
    lower.includes('无语音')
  );
}

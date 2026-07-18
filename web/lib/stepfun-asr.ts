// stepfun-asr.ts
// StepFun 2.5 ASR (stepaudio-2.5-asr) via HTTP + SSE.
// One-shot POST with base64-embedded PCM, server streams transcript.text.delta
// then transcript.text.done. Unlike the DashScope path we do NOT stage the
// audio to a URL - StepFun wants the audio inline as base64.

import { Esp32AiProviderError } from './esp32-ai-provider';
import type { PipelinePusher } from './sse-pipeline-types';

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
      isAbort ? 'asr_timeout' : 'asr_failed',
      isAbort ? 'StepFun ASR request timed out' : 'StepFun ASR request failed',
      isAbort ? 504 : 500
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
      response.status
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let transcript = '';
  let requestId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataPayload = extractSseData(rawEvent);
        if (!dataPayload) continue;
        let json: StepFunAsrEvent;
        try {
          json = JSON.parse(dataPayload) as StepFunAsrEvent;
        } catch {
          continue;
        }
        const type = json.type;
        if (type === 'transcript.text.delta') {
          const delta = typeof json.delta === 'string' ? json.delta : '';
          if (delta) {
            transcript += delta;
            pusher?.emitAsrDelta(delta);
          }
        } else if (type === 'transcript.text.done') {
          if (typeof json.text === 'string' && json.text) {
            transcript = json.text;
          }
          if (json.meta?.session_id) {
            requestId = String(json.meta.session_id);
          }
        } else if (type === 'error') {
          const message = String(json.message || 'StepFun ASR error');
          clearTimeout(timer);
          if (isNoSpeechMessage(message)) {
            throw new Esp32AiProviderError('no_speech', message, 422);
          }
          throw new Esp32AiProviderError('asr_failed', message, 500);
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
    throw new Esp32AiProviderError(
      'asr_failed',
      'StepFun ASR returned no transcript',
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

function extractSseData(rawEvent: string): string | null {
  const lines = rawEvent.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
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

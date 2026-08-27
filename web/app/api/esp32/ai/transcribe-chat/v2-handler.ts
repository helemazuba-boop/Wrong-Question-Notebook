// v2-handler.ts
// v2-streaming branch for /api/esp32/ai/transcribe-chat?protocol=v2-streaming.

import { NextRequest, NextResponse } from 'next/server';

import {
  authenticateEsp32Device,
  type Esp32DeviceAuthContext,
} from '@/lib/esp32-device-auth';
import { createSseResponse, SseWriter } from '@/lib/ai-stream';
import { runStreamingPipeline } from '@/lib/sse-pipeline';
import type { ToolExecutor } from '@/lib/sse-pipeline-chat';
import { logger } from '@/lib/logger';
import {
  getEsp32AiAsrSelection,
  type Esp32AiAsrProvider,
} from '@/lib/esp32-ai-asr-selection';
import { buildAiToolExecutor } from './v2-tools';
import { appendAiToolPrompt } from '@/lib/esp32-ai-tool-definitions';

export const RUNTIME_TAG = 'nodejs';

export interface V2RuntimeConfig {
  dashScopeApiKey: string;
  openAiBaseUrlStd: string;
  openAiBaseUrlPro: string;
  chatApiKeyStd: string;
  chatApiKeyPro: string;
  chatModelStd: string;
  chatModelPro: string;
  asrTaskUrl: string;
  asrTaskStatusBaseUrl: string;
  asrModel: string;
  asrLanguageHints: string[];
  asrTimeoutMs: number;
  asrPollIntervalMs: number;
  asrPollAttempts: number;
  llmTimeoutMs: number;
  audioUrlTtlMs: number;
  publicBaseUrl: string;
  systemPrompt: string;
  asrProvider: Esp32AiAsrProvider;
  asrFallbackProvider: Esp32AiAsrProvider | null;
  stepfunApiKey: string;
  stepfunAsrUrl: string;
  stepfunAsrModel: string;
  stepfunAsrLanguage: string;
  stepfunAsrHotwords: string[];
  stepfunAsrEnableItn: boolean;
}

export interface V2RequestContext {
  authResult: Esp32DeviceAuthContext;
  audio: ArrayBuffer;
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_ASR_TASK_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DEFAULT_TASK_STATUS_BASE_URL =
  'https://dashscope.aliyuncs.com/api/v1/tasks';
const DEFAULT_STEPFUN_ASR_URL = 'https://api.stepfun.com/v1/audio/asr/sse';
const DEFAULT_STEPFUN_ASR_MODEL = 'stepaudio-2.5-asr';

function loadV2RuntimeConfig(): V2RuntimeConfig {
  const asrSelection = getEsp32AiAsrSelection();
  if (!asrSelection) {
    throw new Error('Invalid ESP32 AI ASR provider selection');
  }
  const apiKey = (process.env.DASHSCOPE_API_KEY || '').trim();
  const baseUrl = (
    process.env.DASHSCOPE_OPENAI_BASE_URL || DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const chatKeyStd = (
    process.env.DASHSCOPE_CHAT_API_KEY_STD ||
    process.env.DASHSCOPE_CHAT_API_KEY ||
    apiKey
  ).trim();
  const chatKeyPro = (
    process.env.DASHSCOPE_CHAT_API_KEY_PRO ||
    process.env.DASHSCOPE_CHAT_API_KEY ||
    apiKey
  ).trim();
  const publicBaseUrl = (
    process.env.WQN_ESP32_AI_PUBLIC_BASE_URL ||
    process.env.SITE_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  const asrLangHints = (process.env.DASHSCOPE_ASR_LANGUAGE_HINTS || '')
    .split(',')
    .map(function (v) {
      return v.trim();
    })
    .filter(Boolean);
  return {
    dashScopeApiKey: apiKey,
    // Per-tier base URL overrides mirror getProviderConfig() in
    // lib/esp32-ai-provider.ts: _STD/_PRO win over the shared base URL.
    openAiBaseUrlStd: (process.env.DASHSCOPE_OPENAI_BASE_URL_STD || baseUrl)
      .trim()
      .replace(/\/+$/, ''),
    openAiBaseUrlPro: (process.env.DASHSCOPE_OPENAI_BASE_URL_PRO || baseUrl)
      .trim()
      .replace(/\/+$/, ''),
    chatApiKeyStd: chatKeyStd,
    chatApiKeyPro: chatKeyPro,
    chatModelStd:
      process.env.DASHSCOPE_CHAT_MODEL_STD ||
      process.env.DASHSCOPE_CHAT_MODEL ||
      'qwen-plus',
    chatModelPro: process.env.DASHSCOPE_CHAT_MODEL_PRO || 'qwen-max',
    asrTaskUrl: process.env.DASHSCOPE_ASR_TASK_URL || DEFAULT_ASR_TASK_URL,
    asrTaskStatusBaseUrl: (
      process.env.DASHSCOPE_TASK_STATUS_BASE_URL || DEFAULT_TASK_STATUS_BASE_URL
    ).replace(/\/+$/, ''),
    asrModel: process.env.DASHSCOPE_ASR_MODEL || 'paraformer-v2',
    asrLanguageHints: asrLangHints,
    asrTimeoutMs: positiveInt(process.env.WQN_ESP32_AI_ASR_TIMEOUT_MS, 90000),
    asrPollIntervalMs: positiveInt(
      process.env.DASHSCOPE_ASR_POLL_INTERVAL_MS,
      1000
    ),
    asrPollAttempts: positiveInt(process.env.DASHSCOPE_ASR_POLL_ATTEMPTS, 90),
    llmTimeoutMs: positiveInt(process.env.WQN_ESP32_AI_LLM_TIMEOUT_MS, 360000),
    audioUrlTtlMs: positiveInt(
      process.env.WQN_ESP32_AI_AUDIO_URL_TTL_MS,
      300000
    ),
    publicBaseUrl: publicBaseUrl,
    systemPrompt:
      process.env.WQN_ESP32_AI_SYSTEM_PROMPT ||
      'You are a learning assistant on a WQN e-ink notebook.',
    asrProvider: asrSelection.primary,
    asrFallbackProvider: asrSelection.fallback,
    stepfunApiKey: (process.env.STEPFUN_API_KEY || '').trim(),
    stepfunAsrUrl: (
      process.env.STEPFUN_ASR_URL || DEFAULT_STEPFUN_ASR_URL
    ).replace(/\/+$/, ''),
    stepfunAsrModel: process.env.STEPFUN_ASR_MODEL || DEFAULT_STEPFUN_ASR_MODEL,
    stepfunAsrLanguage: process.env.STEPFUN_ASR_LANGUAGE || 'zh',
    stepfunAsrHotwords: (process.env.STEPFUN_ASR_HOTWORDS || '')
      .split(',')
      .map(function (v) {
        return v.trim();
      })
      .filter(Boolean),
    stepfunAsrEnableItn: process.env.STEPFUN_ASR_ENABLE_ITN !== 'false',
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export async function handleV2Streaming(
  req: NextRequest,
  config?: V2RuntimeConfig,
  requestContext?: V2RequestContext
): Promise<NextResponse> {
  const resolvedConfig = config || loadV2RuntimeConfig();

  const authResult =
    requestContext?.authResult ?? (await authenticateEsp32Device(req));
  if (authResult instanceof Response) return authResult;

  const audio = requestContext?.audio ?? (await req.arrayBuffer());
  const enableThinkingHeader = req.headers.get('x-wqn-enable-thinking');
  const reasoningEffortHeader = req.headers.get('x-wqn-reasoning-effort');
  const enableThinking =
    enableThinkingHeader === null ? undefined : enableThinkingHeader === 'true';
  const reasoningEffort =
    reasoningEffortHeader === 'low' ||
    reasoningEffortHeader === 'medium' ||
    reasoningEffortHeader === 'high'
      ? reasoningEffortHeader
      : undefined;

  let toolExecutor: ToolExecutor | undefined;
  if (authResult.userId) {
    const ctx = {
      userId: authResult.userId,
      conversationId: req.headers.get('x-wqn-conversation-id'),
      deviceId: authResult.deviceId,
    };
    toolExecutor = buildAiToolExecutor(ctx);
  }

  const sse = createSseResponse(async function (writer: SseWriter) {
    try {
      await runStreamingPipeline({
        writer: writer,
        input: {
          audio: audio,
          sampleRate: 16000,
          channels: 1,
          sampleFormat: 's16le',
          conversationId: req.headers.get('x-wqn-conversation-id'),
          tier: req.headers.get('x-wqn-ai-tier'),
          userId: authResult.userId,
          deviceId: authResult.deviceId,
          enableThinking,
          reasoningEffort,
        },
        asrModel: resolvedConfig.asrModel,
        chatModelStd: resolvedConfig.chatModelStd,
        chatModelPro: resolvedConfig.chatModelPro,
        openAiBaseUrlStd: resolvedConfig.openAiBaseUrlStd,
        openAiBaseUrlPro: resolvedConfig.openAiBaseUrlPro,
        dashScopeApiKey: resolvedConfig.dashScopeApiKey,
        chatApiKeyStd: resolvedConfig.chatApiKeyStd,
        chatApiKeyPro: resolvedConfig.chatApiKeyPro,
        asrTaskUrl: resolvedConfig.asrTaskUrl,
        asrTaskStatusBaseUrl: resolvedConfig.asrTaskStatusBaseUrl,
        asrLanguageHints: resolvedConfig.asrLanguageHints,
        asrTimeoutMs: resolvedConfig.asrTimeoutMs,
        asrPollIntervalMs: resolvedConfig.asrPollIntervalMs,
        asrPollAttempts: resolvedConfig.asrPollAttempts,
        llmTimeoutMs: resolvedConfig.llmTimeoutMs,
        audioUrlTtlMs: resolvedConfig.audioUrlTtlMs,
        publicBaseUrl: resolvedConfig.publicBaseUrl,
        systemPrompt: toolExecutor
          ? appendAiToolPrompt(resolvedConfig.systemPrompt)
          : resolvedConfig.systemPrompt,
        toolExecutor: toolExecutor,
        asrProvider: resolvedConfig.asrProvider,
        asrFallbackProvider: resolvedConfig.asrFallbackProvider,
        stepfunApiKey: resolvedConfig.stepfunApiKey,
        stepfunAsrUrl: resolvedConfig.stepfunAsrUrl,
        stepfunAsrModel: resolvedConfig.stepfunAsrModel,
        stepfunAsrLanguage: resolvedConfig.stepfunAsrLanguage,
        stepfunAsrHotwords: resolvedConfig.stepfunAsrHotwords,
        stepfunAsrEnableItn: resolvedConfig.stepfunAsrEnableItn,
      });
    } catch (error) {
      logger.error('v2-streaming pipeline failed', error, {
        component: 'Esp32AiTranscribeChat',
      });
    }
  });
  return new NextResponse(sse.body, {
    status: sse.status,
    statusText: sse.statusText,
    headers: sse.headers,
  });
}

export function isV2StreamingRequest(req: NextRequest): boolean {
  if (req.nextUrl.searchParams.get('protocol') === 'v2-streaming') return true;
  if (req.headers.get('x-wqn-protocol') === 'v2-streaming') return true;
  if (req.headers.get('x-wqn-accept') === 'text/event-stream') return true;
  return false;
}

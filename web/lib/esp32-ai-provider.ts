import {
  AudioStagingError,
  stageEsp32AiAudioFile,
} from '@/lib/esp32-ai-audio-staging';
import { runStepFunAsrSse } from './stepfun-asr';
import {
  createNotebookNoteFromAi,
  getProblemDetail,
  listAuthorizedNotebooks,
  NotebookToolError,
  searchUserProblems,
  type NotebookAiAction,
  type NotebookToolContext,
} from '@/lib/notebooks';
import {
  createTodoFromAi,
  listTodosForAi,
  TodoToolError,
  updateTodoStatusFromAi,
  type TodoAiAction,
  type TodoPriority,
  type TodoStatus,
  type TodoToolContext,
} from '@/lib/todos';
import {
  addWordEntryToDeck,
  createWordDeck,
  listAuthorizedWordDecks,
  recordWordReview,
  searchWords,
  WordToolError,
  type WordAiAction,
  type WordReviewMode,
  type WordReviewOutcome,
  type WordToolContext,
} from '@/lib/words';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  appendTurns,
  contextTurnsForLlm,
  loadTurns,
  mintConversationId,
} from './esp32-ai-conversation-store';

export type Esp32AiProviderErrorCode =
  | 'disabled'
  | 'no_speech'
  | 'invalid_audio'
  | 'asr_failed'
  | 'asr_timeout'
  | 'model_failed'
  | 'chat_timeout'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'notebook_permission_denied'
  | 'todo_failed'
  | 'word_failed';

export class Esp32AiProviderError extends Error {
  constructor(
    public readonly code: Esp32AiProviderErrorCode,
    message: string,
    public readonly status = 500
  ) {
    super(message);
    this.name = 'Esp32AiProviderError';
  }
}

export interface Esp32AiProviderInput {
  audio: ArrayBuffer;
  sampleRate: number;
  channels: number;
  sampleFormat: 's16le';
  conversationId?: string | null;
  tier?: string | null;
  userId?: string | null;
  deviceId?: string | null;
}

export interface Esp32AiProviderResult {
  transcript: string;
  replyText: string;
  conversationId: string | null;
  latencyMs: number;
  actions: Esp32AiAction[];
  statusTrace: Esp32AiStatusTraceItem[];
  asr: Esp32AiAsrSummary;
  functionCalls: Esp32AiFunctionCallSummary[];
}

export interface Esp32WordAiLookupResult {
  word: string;
  normalized_word: string;
  meaning: string;
  example: string | null;
  example_translation: string | null;
  part_of_speech: string | null;
  temporary: true;
}

type Esp32AiAction = NotebookAiAction | TodoAiAction | WordAiAction;
type Esp32AiToolContext = NotebookToolContext &
  TodoToolContext &
  WordToolContext;

type Esp32AiTraceStatus =
  | 'started'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface Esp32AiStatusTraceItem {
  stage: string;
  status: Esp32AiTraceStatus;
  elapsed_ms: number;
  detail?: string;
}

export interface Esp32AiAsrSummary {
  provider: 'dashscope' | 'stepfun';
  model: string;
  status: 'succeeded';
  text: string;
  request_id: string | null;
  elapsed_ms: number;
}

export interface Esp32AiFunctionCallSummary {
  name: string;
  status: 'succeeded' | 'failed';
  display: string;
  action_type?: string;
  title?: string;
}

interface StatusTracker {
  mark: (stage: string, status: Esp32AiTraceStatus, detail?: string) => void;
  items: Esp32AiStatusTraceItem[];
}

interface DashScopeToolCall {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface DashScopeChatMessage {
  role?: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ text?: string }> | null;
  tool_calls?: DashScopeToolCall[];
  tool_call_id?: string;
}

type DashScopeRequestMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: DashScopeToolCall[];
  tool_call_id?: string;
};

interface DashScopeChatResponse {
  id?: string;
  request_id?: string;
  choices?: Array<{
    message?: DashScopeChatMessage;
  }>;
  output?: {
    text?: string;
    choices?: Array<{
      message?: DashScopeChatMessage;
    }>;
  };
}

interface DashScopeTaskResponse {
  request_id?: string;
  output?: {
    task_id?: string;
    task_status?: string;
    message?: string;
    code?: string;
    text?: string;
    result?: unknown;
    results?: unknown[];
    transcription_url?: string;
  };
  result?: unknown;
  results?: unknown[];
  audio_info?: unknown;
}

interface DashScopeProviderConfig {
  apiKey: string;
  chatApiKeyStd: string;
  chatApiKeyPro: string;
  openAiBaseUrl: string;
  openAiBaseUrlStd: string;
  openAiBaseUrlPro: string;
  asrTaskUrl: string;
  taskStatusBaseUrl: string;
  asrModel: string;
  asrLanguageHints: string[];
  chatModel: string;
  chatModelStd: string;
  chatModelPro: string;
  systemPrompt: string;
  asrTimeoutMs: number;
  llmTimeoutMs: number;
  asrPollIntervalMs: number;
  asrPollAttempts: number;
  audioUrlTtlMs: number;
  publicBaseUrl: string;
  asrProvider: 'dashscope' | 'stepfun';
  stepfunApiKey: string;
  stepfunAsrUrl: string;
  stepfunAsrModel: string;
  stepfunAsrLanguage: string;
  stepfunAsrHotwords: string[];
  stepfunAsrEnableItn: boolean;
}

const DASH_SCOPE_PROVIDER = 'dashscope';
const DEFAULT_OPENAI_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_ASR_TASK_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DEFAULT_TASK_STATUS_BASE_URL =
  'https://dashscope.aliyuncs.com/api/v1/tasks';
const DEFAULT_ASR_MODEL = 'paraformer-v2';
const DEFAULT_CHAT_MODEL = 'qwen-plus';
const DEFAULT_STEPFUN_ASR_URL = 'https://api.stepfun.com/v1/audio/asr/sse';
const DEFAULT_STEPFUN_ASR_MODEL = 'stepaudio-2.5-asr';
const DEFAULT_ASR_TIMEOUT_MS = 90_000; // ASR single request: 45s typical, 90s max
const DEFAULT_LLM_TIMEOUT_MS = 360_000; // LLM inference: 5min typical, allow 6min
const DEFAULT_ASR_POLL_INTERVAL_MS = 1000; // 1s between ASR polls (was 800ms)
const DEFAULT_ASR_POLL_ATTEMPTS = 90; // 90 × 1s = 90s max ASR wait (was 45 × 800ms = 36s)
const DEFAULT_AUDIO_URL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SYSTEM_PROMPT_UTF8 =
  '你是 WQN 错题本设备上的学习助手。根据用户语音转写内容，用简洁中文回答，优先帮助用户学习、复习错题和整理遗漏知识点。';

function createStatusTracker(startedAt = Date.now()): StatusTracker {
  return {
    items: [],
    mark(stage, status, detail) {
      this.items.push({
        stage,
        status,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        ...(detail ? { detail } : {}),
      });
    },
  };
}

function actionTitle(action: Esp32AiAction): string {
  if ('title' in action && action.title?.trim()) return action.title.trim();
  if (action.type === 'notebook_note_created') return '笔记';
  if (action.type.startsWith('word_') && 'word' in action) return action.word;
  if (action.type.startsWith('word_')) return '单词';
  return 'Todo';
}

function summarizeAction(action: Esp32AiAction): string {
  if (action.type === 'notebook_note_created') {
    return `已记录：${actionTitle(action)}`;
  }
  if (action.type === 'todo_created') {
    return `已添加 Todo：${actionTitle(action)}`;
  }
  if (action.type === 'todo_status_updated') {
    if (action.status === 'completed') {
      return `已完成 Todo：${actionTitle(action)}`;
    }
    if (action.status === 'cancelled') {
      return `已取消 Todo：${actionTitle(action)}`;
    }
    if (action.status === 'pending') {
      return `已恢复 Todo：${actionTitle(action)}`;
    }
    return `已更新 Todo：${actionTitle(action)}`;
  }
  if (action.type === 'word_deck_created') {
    return `已创建词库：${actionTitle(action)}`;
  }
  if (action.type === 'word_added_to_deck') {
    return `已加入词库：${actionTitle(action)}`;
  }
  if (action.type === 'word_review_recorded') {
    return `已记录单词：${actionTitle(action)}`;
  }
  if (action.type === 'word_added_to_mistakes') {
    return `已加入错词本：${actionTitle(action)}`;
  }
  return '已完成操作';
}

function actionSummariesFrom(
  beforeCount: number,
  actions: Esp32AiAction[]
): Esp32AiFunctionCallSummary[] {
  return actions.slice(beforeCount).map(action => ({
    name: action.type,
    status: 'succeeded',
    display: summarizeAction(action),
    action_type: action.type,
    title: actionTitle(action),
  }));
}

function safeToolCallDisplay(name: string): string {
  if (name === 'list_authorized_notebooks') return '读取授权笔记本';
  if (name === 'create_notebook_note') return '写入笔记';
  if (name === 'search_user_problems') return '搜索错题';
  if (name === 'get_problem_detail') return '读取错题详情';
  if (name === 'list_todos') return '读取 Todo';
  if (name === 'create_todo') return '创建 Todo';
  if (name === 'update_todo_status') return '更新 Todo';
  if (name === 'list_word_decks') return '读取词库';
  if (name === 'create_word_deck') return '创建词库';
  if (name === 'add_word_to_deck') return '添加单词';
  if (name === 'search_words') return '查询单词';
  if (name === 'record_word_review') return '记录单词复习';
  return name ? `调用工具：${name}` : '调用工具';
}

const NOTEBOOK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_authorized_notebooks',
      description: '列出当前用户授权给 AI 访问的空白笔记本及权限。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_notebook_note',
      description: '在用户授权 AI 创建内容的空白笔记本中新增一条笔记。',
      parameters: {
        type: 'object',
        properties: {
          notebook_id: { type: 'string', description: '目标空白笔记本 ID' },
          title: { type: 'string', description: '笔记标题，最多 120 字符' },
          content: { type: 'string', description: '笔记正文，最多 4000 字符' },
          linked_problem_id: {
            type: 'string',
            description: '可选，关联错题 ID',
          },
        },
        required: ['notebook_id', 'title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_user_problems',
      description: '按标题、题干或解析搜索当前用户自己的错题。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          subject_id: { type: 'string', description: '可选科目 ID' },
          limit: { type: 'number', description: '返回数量，最多 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_problem_detail',
      description: '读取当前用户某道错题的题干、解析、答案和状态。',
      parameters: {
        type: 'object',
        properties: {
          problem_id: { type: 'string', description: '错题 ID' },
        },
        required: ['problem_id'],
      },
    },
  },
] as const;

const AI_TOOL_PROMPT = [
  '你可以在需要时调用工具读取当前用户的错题、写入用户明确授权给 AI 的空白笔记本，或管理用户的 Todo。',
  '不要声称已经写入笔记或 Todo，除非 create_notebook_note、create_todo 或 update_todo_status 工具返回成功。',
  '错题本只用于读取错题名称和详情；空白笔记本才允许创建笔记。',
  'Todo 是顶层行动清单，不属于笔记本架。Todo 状态只允许 pending、completed、cancelled。',
  '词库是笔记本架中的第三类内容，类型是 word_deck；它不是 Notebook。设备端仍通过 Word 顶层学习页复习词库。',
  '用户标记不认识的单词时，只能通过 record_word_review outcome=unknown 让服务器加入预设错词本，不要手写错题或笔记。',
  '不要声称已经创建词库、添加单词或记录复习，除非 create_word_deck、add_word_to_deck 或 record_word_review 工具返回成功。',
  '如果没有合适授权或缺少 ID，直接说明需要用户先授权或选择目标。不要编造 notebook_id、problem_id 或 todo_id。',
].join('\n');

const TODO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description: '列出当前用户的 Todo。默认只列出 pending。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'completed', 'cancelled', 'all'],
            description: 'Todo 状态过滤，默认 pending',
          },
          limit: { type: 'number', description: '返回数量，最大 8' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_todo',
      description: '为当前用户创建一个 Todo。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Todo 标题，最大 120 字符' },
          description: {
            type: 'string',
            description: '可选说明，最大 2000 字符',
          },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high'],
            description: '优先级，默认 normal',
          },
          due_at: { type: 'string', description: '可选 ISO 时间' },
          reminder_at: { type: 'string', description: '可选 ISO 时间' },
          subject_id: { type: 'string', description: '可选科目 ID' },
          problem_id: { type: 'string', description: '可选错题 ID' },
          notebook_id: { type: 'string', description: '可选空白笔记本 ID' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todo_status',
      description: '更新当前用户某个 Todo 的状态。不能删除 Todo。',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string', description: 'Todo ID' },
          status: {
            type: 'string',
            enum: ['pending', 'completed', 'cancelled'],
            description: '目标状态',
          },
        },
        required: ['todo_id', 'status'],
      },
    },
  },
] as const;

const WORD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_word_decks',
      description: '列出当前用户可访问或授权给 AI 的词库。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_word_deck',
      description:
        '为当前用户创建一个空白词库。词库会出现在笔记本架中，类型是 word_deck，不是 Notebook。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '词库名称，最大 120 字符' },
          description: {
            type: 'string',
            description: '可选说明，最大 1000 字符',
          },
          subject_id: { type: 'string', description: '可选科目/归档 ID' },
          language: { type: 'string', description: '源语言，默认 en' },
          target_language: {
            type: 'string',
            description: '目标语言，默认 zh-CN',
          },
          lexicon_type: {
            type: 'string',
            enum: ['english_word', 'classical_chinese_term'],
            description:
              '词库类型。本阶段默认 english_word；classical_chinese_term 仅作预留。',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_word_to_deck',
      description: '向用户拥有的非系统词库添加或更新一个单词。',
      parameters: {
        type: 'object',
        properties: {
          deck_id: { type: 'string', description: '目标词库 ID' },
          word: { type: 'string', description: '英文单词或短语' },
          phonetic: { type: 'string', description: '可选音标' },
          meaning: { type: 'string', description: '中文释义' },
          example: { type: 'string', description: '可选例句' },
          example_translation: { type: 'string', description: '可选例句翻译' },
          part_of_speech: { type: 'string', description: '可选词性' },
        },
        required: ['deck_id', 'word', 'meaning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_words',
      description: '按前缀或关键词查询当前用户可访问的词库单词。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '查询关键词' },
          prefix: { type: 'string', description: '单词前缀' },
          deck_id: { type: 'string', description: '可选词库 ID' },
          limit: { type: 'number', description: '返回数量，最大 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_word_review',
      description:
        '记录用户对一个单词的复习结果。unknown 会由服务器加入预设错词本。',
      parameters: {
        type: 'object',
        properties: {
          word_entry_id: { type: 'string', description: '单词条目 ID' },
          outcome: {
            type: 'string',
            enum: ['known', 'unknown', 'skip'],
            description: '复习结果',
          },
          mode: {
            type: 'string',
            enum: ['sequential', 'random', 'dictionary'],
            description: '复习模式，默认 sequential',
          },
        },
        required: ['word_entry_id', 'outcome'],
      },
    },
  },
] as const;

const AI_TOOLS = [...NOTEBOOK_TOOLS, ...TODO_TOOLS, ...WORD_TOOLS] as const;

function isDashScopeProviderConfigured(): boolean {
  // Chat always goes through DashScope (qwen). ASR may be DashScope
  // (paraformer-v2) or StepFun (stepaudio-2.5-asr), so the ASR provider
  // does not gate overall AI enablement - only the chat provider does.
  return (
    (process.env.WQN_ESP32_AI_CHAT_PROVIDER || DASH_SCOPE_PROVIDER) ===
    DASH_SCOPE_PROVIDER
  );
}

function normalizeLookupWord(value: string): string {
  return value.trim().slice(0, 80).toLocaleLowerCase('en-US');
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getCommaSeparatedEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function getProviderConfig(): DashScopeProviderConfig | null {
  if (!isDashScopeProviderConfigured()) return null;

  const apiKey = (process.env.DASHSCOPE_API_KEY || '').trim();
  if (!apiKey) return null;

  const chatApiKeyStd = (
    process.env.DASHSCOPE_CHAT_API_KEY_STD ||
    process.env.DASHSCOPE_CHAT_API_KEY ||
    apiKey
  ).trim();
  const chatApiKeyPro = (
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
  if (!publicBaseUrl) return null;

  return {
    apiKey,
    chatApiKeyStd,
    chatApiKeyPro,
    openAiBaseUrl: (
      process.env.DASHSCOPE_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL
    ).replace(/\/+$/, ''),
    openAiBaseUrlStd: (
      process.env.DASHSCOPE_OPENAI_BASE_URL_STD ||
      process.env.DASHSCOPE_OPENAI_BASE_URL ||
      DEFAULT_OPENAI_BASE_URL
    ).replace(/\/+$/, ''),
    openAiBaseUrlPro: (
      process.env.DASHSCOPE_OPENAI_BASE_URL_PRO ||
      process.env.DASHSCOPE_OPENAI_BASE_URL ||
      DEFAULT_OPENAI_BASE_URL
    ).replace(/\/+$/, ''),
    asrTaskUrl: process.env.DASHSCOPE_ASR_TASK_URL || DEFAULT_ASR_TASK_URL,
    taskStatusBaseUrl: (
      process.env.DASHSCOPE_TASK_STATUS_BASE_URL || DEFAULT_TASK_STATUS_BASE_URL
    ).replace(/\/+$/, ''),
    asrModel: process.env.DASHSCOPE_ASR_MODEL || DEFAULT_ASR_MODEL,
    asrLanguageHints: getCommaSeparatedEnv('DASHSCOPE_ASR_LANGUAGE_HINTS'),
    chatModel: process.env.DASHSCOPE_CHAT_MODEL || DEFAULT_CHAT_MODEL,
    chatModelStd:
      process.env.DASHSCOPE_CHAT_MODEL_STD ||
      process.env.DASHSCOPE_CHAT_MODEL ||
      DEFAULT_CHAT_MODEL,
    chatModelPro: process.env.DASHSCOPE_CHAT_MODEL_PRO || 'qwen-max',
    systemPrompt:
      process.env.WQN_ESP32_AI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT_UTF8,
    asrTimeoutMs: getPositiveIntegerEnv(
      'WQN_ESP32_AI_ASR_TIMEOUT_MS',
      DEFAULT_ASR_TIMEOUT_MS
    ),
    llmTimeoutMs: getPositiveIntegerEnv(
      'WQN_ESP32_AI_LLM_TIMEOUT_MS',
      DEFAULT_LLM_TIMEOUT_MS
    ),
    asrPollIntervalMs: getPositiveIntegerEnv(
      'DASHSCOPE_ASR_POLL_INTERVAL_MS',
      DEFAULT_ASR_POLL_INTERVAL_MS
    ),
    asrPollAttempts: getPositiveIntegerEnv(
      'DASHSCOPE_ASR_POLL_ATTEMPTS',
      DEFAULT_ASR_POLL_ATTEMPTS
    ),
    audioUrlTtlMs: getPositiveIntegerEnv(
      'WQN_ESP32_AI_AUDIO_URL_TTL_MS',
      DEFAULT_AUDIO_URL_TTL_MS
    ),
    publicBaseUrl,
    asrProvider:
      process.env.WQN_ESP32_AI_ASR_PROVIDER === 'stepfun'
        ? 'stepfun'
        : 'dashscope',
    stepfunApiKey: (process.env.STEPFUN_API_KEY || '').trim(),
    stepfunAsrUrl: (
      process.env.STEPFUN_ASR_URL || DEFAULT_STEPFUN_ASR_URL
    ).replace(/\/+$/, ''),
    stepfunAsrModel: process.env.STEPFUN_ASR_MODEL || DEFAULT_STEPFUN_ASR_MODEL,
    stepfunAsrLanguage: process.env.STEPFUN_ASR_LANGUAGE || 'zh',
    stepfunAsrHotwords: getCommaSeparatedEnv('STEPFUN_ASR_HOTWORDS'),
    stepfunAsrEnableItn: process.env.STEPFUN_ASR_ENABLE_ITN !== 'false',
  };
}

function extractContentText(
  content?: string | Array<{ text?: string }> | null
): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => part.text ?? '')
      .join('')
      .trim();
  }
  return '';
}

function extractChatMessage(
  response: DashScopeChatResponse
): DashScopeChatMessage | null {
  return (
    response.choices?.[0]?.message ??
    response.output?.choices?.[0]?.message ??
    null
  );
}

function extractChatText(response: DashScopeChatResponse): string {
  const message = extractChatMessage(response);
  const messageText = extractContentText(message?.content);
  if (messageText) return messageText;

  return (response.output?.text || '').trim();
}

function extractJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through to provider error below
      }
    }
  }

  throw new Esp32AiProviderError(
    'model_failed',
    'AI lookup response was not valid JSON',
    500
  );
}

function optionalLookupString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

function extractTranscriptFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  const directText = record.text;
  if (typeof directText === 'string' && directText.trim()) {
    return directText.trim();
  }

  const resultText = extractTranscriptFromUnknown(record.result);
  if (resultText) return resultText;

  const outputText = extractTranscriptFromUnknown(record.output);
  if (outputText) return outputText;

  const results = record.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      const text = extractTranscriptFromUnknown(item);
      if (text) return text;
    }
  }

  const utterances = record.utterances;
  if (Array.isArray(utterances)) {
    const text = utterances
      .map(item => extractTranscriptFromUnknown(item))
      .filter(Boolean)
      .join('');
    if (text.trim()) return text.trim();
  }

  const transcripts = record.transcripts;
  if (Array.isArray(transcripts)) {
    const text = transcripts
      .map(item => extractTranscriptFromUnknown(item))
      .filter(Boolean)
      .join('');
    if (text.trim()) return text.trim();
  }

  const sentences = record.sentences;
  if (Array.isArray(sentences)) {
    const text = sentences
      .map(item => extractTranscriptFromUnknown(item))
      .filter(Boolean)
      .join('');
    if (text.trim()) return text.trim();
  }

  return '';
}

function describeDashScopeTask(response: DashScopeTaskResponse): string {
  const output = response.output || {};
  const fields = [
    `status=${String(output.task_status || 'unknown')}`,
    output.code ? `code=${String(output.code)}` : '',
    output.message ? `message=${String(output.message)}` : '',
  ].filter(Boolean);

  const resultUrl = getTranscriptionResultUrl(response);
  if (resultUrl) fields.push('transcription_url=present');

  if (Array.isArray(output.results)) {
    fields.push(`results=${output.results.length}`);
  } else if (Array.isArray(response.results)) {
    fields.push(`results=${response.results.length}`);
  }

  return fields.join(' ');
}

function getTranscriptionResultUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const directUrl = record.transcription_url;
  if (typeof directUrl === 'string' && directUrl) return directUrl;

  const outputUrl = getTranscriptionResultUrl(record.output);
  if (outputUrl) return outputUrl;

  const results = record.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      const url = getTranscriptionResultUrl(item);
      if (url) return url;
    }
  }

  return null;
}

function providerErrorFromStatus(
  status: number,
  stage: 'asr' | 'chat'
): Esp32AiProviderError {
  if (status === 429) {
    return new Esp32AiProviderError(
      'rate_limited',
      'ESP32 AI provider rate limited',
      429
    );
  }

  if (status >= 500) {
    return new Esp32AiProviderError(
      'provider_unavailable',
      stage === 'asr'
        ? `DashScope ASR service error (HTTP ${status})`
        : `DashScope chat service error (HTTP ${status})`,
      status
    );
  }

  return new Esp32AiProviderError(
    stage === 'asr' ? 'asr_failed' : 'model_failed',
    stage === 'asr'
      ? `DashScope ASR request failed (HTTP ${status})`
      : `DashScope chat request failed (HTTP ${status})`,
    status
  );
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  stage: 'asr' | 'chat'
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw providerErrorFromStatus(response.status, stage);

    try {
      return (await response.json()) as T;
    } catch {
      throw new Esp32AiProviderError(
        stage === 'asr' ? 'asr_failed' : 'model_failed',
        stage === 'asr'
          ? 'DashScope ASR response is not JSON'
          : 'DashScope chat response is not JSON',
        500
      );
    }
  } catch (error) {
    if (error instanceof Esp32AiProviderError) throw error;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new Esp32AiProviderError(
      isAbort
        ? stage === 'asr'
          ? 'asr_timeout'
          : 'chat_timeout'
        : stage === 'asr'
          ? 'asr_failed'
          : 'model_failed',
      isAbort
        ? stage === 'asr'
          ? 'DashScope ASR request timed out'
          : 'DashScope chat request timed out'
        : stage === 'asr'
          ? 'DashScope ASR request failed'
          : 'DashScope chat request failed',
      isAbort ? 504 : 500
    );
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createDashScopeAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function submitParaformerTask(
  config: DashScopeProviderConfig,
  fileUrl: string
): Promise<{ taskId: string; requestId: string | null }> {
  const parameters: Record<string, unknown> = {};
  if (config.asrLanguageHints.length > 0) {
    parameters.language_hints = config.asrLanguageHints;
  }

  const response = await fetchJsonWithTimeout<DashScopeTaskResponse>(
    config.asrTaskUrl,
    {
      method: 'POST',
      headers: {
        ...createDashScopeAuthHeaders(config.apiKey),
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model: config.asrModel,
        input: {
          file_urls: [fileUrl],
        },
        parameters,
      }),
    },
    config.asrTimeoutMs,
    'asr'
  );

  const taskId = response.output?.task_id;
  if (!taskId) {
    throw new Esp32AiProviderError(
      'asr_failed',
      'DashScope ASR task response did not contain task_id',
      500
    );
  }

  return { taskId, requestId: response.request_id || null };
}

async function queryParaformerTask(
  config: DashScopeProviderConfig,
  taskId: string
): Promise<DashScopeTaskResponse> {
  return fetchJsonWithTimeout<DashScopeTaskResponse>(
    `${config.taskStatusBaseUrl}/${encodeURIComponent(taskId)}`,
    {
      method: 'GET',
      headers: createDashScopeAuthHeaders(config.apiKey),
    },
    config.asrTimeoutMs,
    'asr'
  );
}

function isNoSpeechResponse(response: DashScopeTaskResponse): boolean {
  const output = response.output || {};
  const code = String(output.code || '').toLowerCase();
  const message = String(output.message || '').toLowerCase();
  return (
    code.includes('no_speech') ||
    code.includes('no_valid_audio') ||
    message.includes('no speech') ||
    message.includes('silent') ||
    message.includes('静音')
  );
}

async function fetchTranscriptResultUrl(
  config: DashScopeProviderConfig,
  url: string
): Promise<string> {
  const response = await fetchJsonWithTimeout<unknown>(
    url,
    { method: 'GET' },
    config.asrTimeoutMs,
    'asr'
  );
  return extractTranscriptFromUnknown(response);
}

async function waitForParaformerTranscript(
  config: DashScopeProviderConfig,
  taskId: string,
  tracker?: StatusTracker
): Promise<string> {
  for (let attempt = 0; attempt < config.asrPollAttempts; attempt += 1) {
    if (attempt > 0) await sleep(config.asrPollIntervalMs);

    const response = await queryParaformerTask(config, taskId);
    const status = response.output?.task_status?.toUpperCase();
    tracker?.mark(
      'asr_poll',
      status === 'SUCCEEDED'
        ? 'succeeded'
        : status === 'FAILED' || status === 'CANCELED'
          ? 'failed'
          : 'pending',
      `attempt=${attempt + 1} status=${status || 'unknown'}`
    );

    if (status === 'SUCCEEDED') {
      const inlineTranscript = extractTranscriptFromUnknown(response);
      if (inlineTranscript) return inlineTranscript;

      const resultUrl = getTranscriptionResultUrl(response);
      if (resultUrl) {
        tracker?.mark('asr_result_fetch', 'started');
        const transcript = await fetchTranscriptResultUrl(config, resultUrl);
        if (transcript) {
          tracker?.mark('asr_result_fetch', 'succeeded');
          return transcript;
        }
      }

      throw new Esp32AiProviderError(
        'asr_failed',
        `DashScope ASR result did not contain transcript (${describeDashScopeTask(response)})`,
        500
      );
    }

    if (status === 'FAILED' || status === 'CANCELED') {
      if (isNoSpeechResponse(response)) {
        throw new Esp32AiProviderError(
          'no_speech',
          'DashScope ASR detected no speech',
          422
        );
      }
      throw new Esp32AiProviderError(
        'asr_failed',
        `DashScope ASR task failed (${describeDashScopeTask(response)})`,
        500
      );
    }
  }

  throw new Esp32AiProviderError(
    'asr_timeout',
    'DashScope ASR task timed out after polling',
    504
  );
}

async function runParaformerAsr(
  config: DashScopeProviderConfig,
  input: Esp32AiProviderInput,
  tracker?: StatusTracker
): Promise<{
  transcript: string;
  requestId: string | null;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  if (input.sampleFormat !== 's16le' || input.sampleRate !== 16000) {
    throw new Esp32AiProviderError(
      'asr_failed',
      'Unsupported audio format for DashScope ASR provider',
      500
    );
  }

  let stagedAudio:
    | Awaited<ReturnType<typeof stageEsp32AiAudioFile>>
    | undefined;

  try {
    tracker?.mark('audio_stage', 'started');
    stagedAudio = await stageEsp32AiAudioFile({
      audio: input.audio,
      sampleRate: input.sampleRate,
      channels: input.channels,
      publicBaseUrl: config.publicBaseUrl,
      ttlMs: config.audioUrlTtlMs,
    });
    tracker?.mark('audio_stage', 'succeeded');

    tracker?.mark('asr_submit', 'started');
    const submitted = await submitParaformerTask(config, stagedAudio.url);
    tracker?.mark('asr_submit', 'succeeded', 'task accepted');
    const transcript = await waitForParaformerTranscript(
      config,
      submitted.taskId,
      tracker
    );

    return {
      transcript,
      requestId: submitted.requestId || submitted.taskId,
      elapsedMs: Date.now() - startedAt,
    };
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

async function runDashScopeAsr(
  config: DashScopeProviderConfig,
  input: Esp32AiProviderInput,
  tracker?: StatusTracker
): Promise<{
  transcript: string;
  requestId: string | null;
  elapsedMs: number;
}> {
  if (config.asrModel !== 'paraformer-v2') {
    throw new Esp32AiProviderError(
      'disabled',
      'Only DashScope paraformer-v2 is enabled for ESP32 ASR',
      503
    );
  }

  return runParaformerAsr(config, input, tracker);
}

async function buildAuthorizedNotebookPrompt(
  ctx?: NotebookToolContext
): Promise<string> {
  if (!ctx) {
    return '当前请求没有用户笔记本上下文，不能调用笔记本或错题工具。';
  }

  try {
    const result = await listAuthorizedNotebooks(ctx);
    if (result.notebooks.length === 0) {
      return '当前用户没有授权给 AI 的空白笔记本。';
    }

    const notebooks = result.notebooks.filter(
      (notebook): notebook is NonNullable<typeof notebook> => notebook !== null
    );
    if (notebooks.length === 0) {
      return '当前用户没有授权给 AI 的空白笔记本。';
    }

    const lines = notebooks.map(notebook => {
      const permissions = [
        notebook.permissions.can_read ? 'read' : '',
        notebook.permissions.can_create ? 'create' : '',
        notebook.permissions.can_update ? 'update' : '',
      ]
        .filter(Boolean)
        .join(',');
      return `- ${notebook.title} (${notebook.id}) 科目:${notebook.subject_name || '未分类'} 权限:${permissions || 'none'} 笔记数:${notebook.note_count}`;
    });

    return `当前用户授权给 AI 的空白笔记本：\n${lines.join('\n')}`;
  } catch {
    return '当前无法读取授权笔记本列表；除非工具调用成功，否则不要声称写入笔记。';
  }
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new NotebookToolError(
      'invalid_tool_arguments',
      'Tool arguments are not valid JSON',
      400
    );
  }
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  required = false
): string | null {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) {
    throw new NotebookToolError(
      'invalid_tool_arguments',
      `Missing required argument: ${key}`,
      400
    );
  }
  return null;
}

function numberArg(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function todoStatusArg(
  args: Record<string, unknown>,
  key: string,
  required = false
): TodoStatus | 'all' | null {
  const value = stringArg(args, key, required);
  if (!value) return null;
  if (['pending', 'completed', 'cancelled', 'all'].includes(value)) {
    return value as TodoStatus | 'all';
  }
  throw new TodoToolError(
    'invalid_tool_arguments',
    `Invalid Todo status: ${value}`,
    400
  );
}

function todoPriorityArg(
  args: Record<string, unknown>,
  key: string
): TodoPriority | undefined {
  const value = stringArg(args, key);
  if (!value) return undefined;
  if (['low', 'normal', 'high'].includes(value)) return value as TodoPriority;
  throw new TodoToolError(
    'invalid_tool_arguments',
    `Invalid Todo priority: ${value}`,
    400
  );
}

function wordReviewOutcomeArg(
  args: Record<string, unknown>,
  key: string,
  required = false
): WordReviewOutcome | null {
  const value = stringArg(args, key, required);
  if (!value) return null;
  if (['known', 'unknown', 'skip'].includes(value)) {
    return value as WordReviewOutcome;
  }
  throw new WordToolError(
    'invalid_tool_arguments',
    `Invalid word review outcome: ${value}`,
    400
  );
}

function wordReviewModeArg(
  args: Record<string, unknown>,
  key: string
): WordReviewMode | undefined {
  const value = stringArg(args, key);
  if (!value) return undefined;
  if (['sequential', 'random', 'dictionary'].includes(value)) {
    return value as WordReviewMode;
  }
  throw new WordToolError(
    'invalid_tool_arguments',
    `Invalid word review mode: ${value}`,
    400
  );
}

function safeToolErrorPayload(error: unknown) {
  if (error instanceof NotebookToolError) {
    return {
      code: error.code,
      message:
        error.code === 'database_error'
          ? 'Notebook database operation failed'
          : error.message,
    };
  }
  if (error instanceof TodoToolError) {
    return {
      code: error.code,
      message:
        error.code === 'database_error'
          ? 'Todo database operation failed'
          : error.message,
    };
  }
  if (error instanceof WordToolError) {
    return {
      code: error.code,
      message:
        error.code === 'database_error'
          ? 'Word database operation failed'
          : error.message,
    };
  }
  return {
    code: 'tool_failed',
    message: 'AI tool failed',
  };
}

async function executeAiToolCall(
  ctx: Esp32AiToolContext | undefined,
  call: DashScopeToolCall,
  actions: Esp32AiAction[],
  functionCalls?: Esp32AiFunctionCallSummary[]
): Promise<unknown> {
  const name = call.function?.name || '';
  if (!ctx) {
    functionCalls?.push({
      name,
      status: 'failed',
      display: `${safeToolCallDisplay(name)}失败`,
    });
    return {
      success: false,
      error: {
        code: 'tool_context_missing',
        message: 'AI tools are unavailable for this request',
      },
    };
  }

  try {
    const args = parseToolArguments(call.function?.arguments);

    if (name === 'list_authorized_notebooks') {
      const data = await listAuthorizedNotebooks(ctx);
      functionCalls?.push({
        name,
        status: 'succeeded',
        display: safeToolCallDisplay(name),
      });
      return { success: true, data };
    }

    if (name === 'create_notebook_note') {
      const beforeCount = actions.length;
      const result = await createNotebookNoteFromAi(ctx, {
        notebook_id: stringArg(args, 'notebook_id', true)!,
        title: stringArg(args, 'title', true)!,
        content: stringArg(args, 'content', true)!,
        linked_problem_id: stringArg(args, 'linked_problem_id') || null,
      });
      actions.push(result.action);
      functionCalls?.push(...actionSummariesFrom(beforeCount, actions));
      return { success: true, data: result.note };
    }

    if (name === 'search_user_problems') {
      const data = await searchUserProblems(ctx, {
        query: stringArg(args, 'query', true)!,
        subject_id: stringArg(args, 'subject_id'),
        limit: numberArg(args, 'limit'),
      });
      functionCalls?.push({
        name,
        status: 'succeeded',
        display: safeToolCallDisplay(name),
      });
      return {
        success: true,
        data,
      };
    }

    if (name === 'get_problem_detail') {
      const data = await getProblemDetail(ctx, {
        problem_id: stringArg(args, 'problem_id', true)!,
      });
      functionCalls?.push({
        name,
        status: 'succeeded',
        display: safeToolCallDisplay(name),
      });
      return {
        success: true,
        data,
      };
    }

    if (name === 'list_todos') {
      const data = await listTodosForAi(ctx, {
        status: todoStatusArg(args, 'status') || 'pending',
        limit: numberArg(args, 'limit'),
      });
      functionCalls?.push({
        name,
        status: 'succeeded',
        display: safeToolCallDisplay(name),
      });
      return {
        success: true,
        data,
      };
    }

    if (name === 'create_todo') {
      const beforeCount = actions.length;
      const result = await createTodoFromAi(ctx, {
        title: stringArg(args, 'title', true)!,
        description: stringArg(args, 'description'),
        priority: todoPriorityArg(args, 'priority'),
        due_at: stringArg(args, 'due_at'),
        reminder_at: stringArg(args, 'reminder_at'),
        subject_id: stringArg(args, 'subject_id'),
        problem_id: stringArg(args, 'problem_id'),
        notebook_id: stringArg(args, 'notebook_id'),
      });
      actions.push(result.action);
      functionCalls?.push(...actionSummariesFrom(beforeCount, actions));
      return { success: true, data: result.todo };
    }

    if (name === 'update_todo_status') {
      const beforeCount = actions.length;
      const status = todoStatusArg(args, 'status', true);
      if (status === 'all') {
        throw new TodoToolError(
          'invalid_tool_arguments',
          'Todo status cannot be all for update',
          400
        );
      }
      const result = await updateTodoStatusFromAi(ctx, {
        todo_id: stringArg(args, 'todo_id', true)!,
        status: status!,
      });
      actions.push(result.action);
      functionCalls?.push(...actionSummariesFrom(beforeCount, actions));
      return { success: true, data: result.todo };
    }

    if (name === 'list_word_decks') {
      const data = await listAuthorizedWordDecks(ctx);
      functionCalls?.push({
        name,
        status: 'succeeded',
        display: safeToolCallDisplay(name),
      });
      return { success: true, data };
    }

    if (name === 'create_word_deck') {
      const beforeCount = actions.length;
      const result = await createWordDeck(ctx.supabase, ctx.userId, {
        title: stringArg(args, 'title', true)!,
        description: stringArg(args, 'description'),
        subject_id: stringArg(args, 'subject_id'),
        language: stringArg(args, 'language') || undefined,
        target_language: stringArg(args, 'target_language') || undefined,
        lexicon_type:
          stringArg(args, 'lexicon_type') === 'classical_chinese_term'
            ? 'classical_chinese_term'
            : 'english_word',
        source: 'ai',
      });
      actions.push(result.action);
      functionCalls?.push(...actionSummariesFrom(beforeCount, actions));
      return { success: true, data: result.deck };
    }

    if (name === 'add_word_to_deck') {
      const beforeCount = actions.length;
      const result = await addWordEntryToDeck(
        ctx.supabase,
        ctx.userId,
        stringArg(args, 'deck_id', true)!,
        {
          word: stringArg(args, 'word', true)!,
          phonetic: stringArg(args, 'phonetic'),
          meaning: stringArg(args, 'meaning', true)!,
          example: stringArg(args, 'example'),
          example_translation: stringArg(args, 'example_translation'),
          part_of_speech: stringArg(args, 'part_of_speech'),
        }
      );
      actions.push(result.action);
      functionCalls?.push(...actionSummariesFrom(beforeCount, actions));
      return { success: true, data: result.entry };
    }

    if (name === 'search_words') {
      const data = await searchWords(ctx.supabase, ctx.userId, {
        q: stringArg(args, 'q'),
        prefix: stringArg(args, 'prefix'),
        deck_id: stringArg(args, 'deck_id'),
        limit: numberArg(args, 'limit'),
      });
      functionCalls?.push({
        name,
        status: 'succeeded',
        display: safeToolCallDisplay(name),
      });
      return { success: true, data: { words: data } };
    }

    if (name === 'record_word_review') {
      const beforeCount = actions.length;
      const outcome = wordReviewOutcomeArg(args, 'outcome', true)!;
      const result = await recordWordReview(ctx, {
        word_entry_id: stringArg(args, 'word_entry_id', true)!,
        outcome,
        mode: wordReviewModeArg(args, 'mode'),
      });
      actions.push(result.action, ...result.extra_actions);
      functionCalls?.push(...actionSummariesFrom(beforeCount, actions));
      return {
        success: true,
        data: {
          action: result.action,
          actions: [result.action, ...result.extra_actions],
        },
      };
    }

    functionCalls?.push({
      name,
      status: 'failed',
      display: `未知工具：${name || 'unnamed'}`,
    });
    return {
      success: false,
      error: {
        code: 'unknown_tool',
        message: `Unknown tool: ${name || 'unnamed'}`,
      },
    };
  } catch (error) {
    functionCalls?.push({
      name,
      status: 'failed',
      display: `${safeToolCallDisplay(name)}失败`,
    });
    return {
      success: false,
      error: safeToolErrorPayload(error),
    };
  }
}

async function runDashScopeChat(
  config: DashScopeProviderConfig,
  transcript: string,
  conversationId?: string | null,
  userId?: string | null,
  deviceId?: string | null,
  tier?: string | null,
  toolContext?: Esp32AiToolContext,
  tracker?: StatusTracker,
  chatModel?: string,
  baseUrl?: string,
  authKey?: string
): Promise<{
  replyText: string;
  conversationId: string;
  requestId: string | null;
  actions: Esp32AiAction[];
  functionCalls: Esp32AiFunctionCallSummary[];
}> {
  const actions: Esp32AiAction[] = [];
  const functionCalls: Esp32AiFunctionCallSummary[] = [];
  const startedAt = Date.now();
  tracker?.mark('chat', 'started');
  const notebookPrompt = await buildAuthorizedNotebookPrompt(toolContext);
  const activeConversationId = conversationId || mintConversationId();
  const priorTurns = userId
    ? await loadTurns(userId, activeConversationId)
    : [];
  const messages: DashScopeRequestMessage[] = [
    {
      role: 'system',
      content: `${config.systemPrompt}\n\n${AI_TOOL_PROMPT}\n\n${notebookPrompt}`,
    },
  ];
  for (const turn of contextTurnsForLlm(priorTurns)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: `用户语音转写：${transcript}` });

  let lastRequestId: string | null = null;
  for (let round = 0; round < 4; round += 1) {
    tracker?.mark('chat_round', 'started', `round=${round + 1}`);
    const response = await fetchJsonWithTimeout<DashScopeChatResponse>(
      `${baseUrl || config.openAiBaseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: createDashScopeAuthHeaders(authKey || config.chatApiKeyStd),
        body: JSON.stringify({
          model: chatModel || config.chatModel,
          messages,
          tools: toolContext ? AI_TOOLS : undefined,
          tool_choice: toolContext ? 'auto' : undefined,
          stream: false,
          temperature: 0.3,
        }),
      },
      config.llmTimeoutMs,
      'chat'
    );

    lastRequestId = response.request_id || response.id || lastRequestId;
    const message = extractChatMessage(response);
    const toolCalls = (message?.tool_calls || []).filter(
      call => call.type === 'function' || call.function?.name
    );

    if (toolCalls.length === 0) {
      const replyText = extractChatText(response);
      if (!replyText) {
        throw new Esp32AiProviderError(
          'model_failed',
          'DashScope chat response did not contain reply',
          500
        );
      }

      tracker?.mark('chat_round', 'succeeded', `round=${round + 1}`);
      tracker?.mark(
        'chat',
        'succeeded',
        `elapsed_ms=${Date.now() - startedAt}`
      );
      if (userId && replyText) {
        const now = new Date().toISOString();
        await appendTurns(
          userId,
          activeConversationId,
          tier || 'std',
          deviceId ?? null,
          [
            { role: 'user', content: transcript, created_at: now },
            { role: 'assistant', content: replyText, created_at: now },
          ]
        );
      }
      return {
        replyText,
        conversationId: activeConversationId,
        requestId: lastRequestId,
        actions,
        functionCalls,
      };
    }

    tracker?.mark(
      'function_call',
      'started',
      `round=${round + 1} count=${toolCalls.length}`
    );

    const normalizedToolCalls = toolCalls.map((call, index) => ({
      ...call,
      id: call.id || `tool-${round}-${index}`,
    }));

    messages.push({
      role: 'assistant',
      content: extractContentText(message?.content) || null,
      tool_calls: normalizedToolCalls,
    });

    for (const call of normalizedToolCalls) {
      const toolResult = await executeAiToolCall(
        toolContext,
        call,
        actions,
        functionCalls
      );
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(toolResult),
      });
    }
    tracker?.mark(
      'function_call',
      'succeeded',
      `round=${round + 1} count=${toolCalls.length}`
    );
  }

  throw new Esp32AiProviderError(
    'model_failed',
    'DashScope chat tool loop exceeded maximum rounds',
    500
  );
}

export function isEsp32AiProviderConfigured(): boolean {
  return Boolean(getProviderConfig());
}

export async function runEsp32WordAiLookup(input: {
  word: string;
  context?: string | null;
}): Promise<Esp32WordAiLookupResult> {
  const config = getProviderConfig();
  if (!config) {
    throw new Esp32AiProviderError(
      'disabled',
      'ESP32 word AI lookup is disabled',
      503
    );
  }

  const word = input.word.trim().slice(0, 80);
  if (!word) {
    throw new Esp32AiProviderError(
      'model_failed',
      'Lookup word is required',
      400
    );
  }

  const response = await fetchJsonWithTimeout<DashScopeChatResponse>(
    `${config.openAiBaseUrlStd}/chat/completions`,
    {
      method: 'POST',
      headers: createDashScopeAuthHeaders(config.chatApiKeyStd),
      body: JSON.stringify({
        model: config.chatModelStd,
        messages: [
          {
            role: 'system',
            content:
              'Return only compact JSON for an English vocabulary lookup. Schema: {"meaning":"中文释义","example":"English example","example_translation":"中文例句翻译","part_of_speech":"词性"}. Do not include markdown.',
          },
          {
            role: 'user',
            content: input.context
              ? `word: ${word}\ncontext: ${input.context.slice(0, 500)}`
              : `word: ${word}`,
          },
        ],
        stream: false,
        temperature: 0.2,
      }),
    },
    config.llmTimeoutMs,
    'chat'
  );

  const raw = extractChatText(response);
  if (!raw) {
    throw new Esp32AiProviderError(
      'model_failed',
      'AI lookup response was empty',
      500
    );
  }

  const parsed = extractJsonObject(raw);
  const meaning = optionalLookupString(parsed.meaning, 1000);
  if (!meaning) {
    throw new Esp32AiProviderError(
      'model_failed',
      'AI lookup response did not contain meaning',
      500
    );
  }

  return {
    word,
    normalized_word: normalizeLookupWord(word),
    meaning,
    example: optionalLookupString(parsed.example, 1000),
    example_translation: optionalLookupString(parsed.example_translation, 1000),
    part_of_speech: optionalLookupString(parsed.part_of_speech, 64),
    temporary: true,
  };
}

export async function runEsp32AiProvider(
  input: Esp32AiProviderInput
): Promise<Esp32AiProviderResult> {
  const config = getProviderConfig();
  if (!config) {
    throw new Esp32AiProviderError(
      'disabled',
      'ESP32 AI voice route is disabled',
      503
    );
  }

  const startedAt = Date.now();
  const tracker = createStatusTracker(startedAt);
  tracker.mark('request', 'started');
  tracker.mark('asr', 'started');
  let asr: { transcript: string; requestId: string | null; elapsedMs: number };
  if (config.asrProvider === 'stepfun') {
    asr = await runStepFunAsrSse(
      {
        stepfunApiKey: config.stepfunApiKey,
        stepfunAsrUrl: config.stepfunAsrUrl,
        stepfunAsrModel: config.stepfunAsrModel,
        stepfunAsrLanguage: config.stepfunAsrLanguage,
        stepfunAsrHotwords: config.stepfunAsrHotwords,
        stepfunAsrEnableItn: config.stepfunAsrEnableItn,
        asrTimeoutMs: config.asrTimeoutMs,
      },
      input.audio,
      input.sampleRate,
      input.channels
    );
  } else {
    asr = await runDashScopeAsr(config, input, tracker);
  }
  tracker.mark(
    'asr',
    'succeeded',
    `text_bytes=${Buffer.byteLength(asr.transcript, 'utf8')}`
  );
  const toolContext = input.userId
    ? {
        userId: input.userId,
        conversationId: input.conversationId,
        deviceId: input.deviceId,
        supabase: createServiceClient(),
      }
    : undefined;
  const selectedModel =
    input.tier === 'pro' ? config.chatModelPro : config.chatModelStd;
  const selectedBaseUrl =
    input.tier === 'pro' ? config.openAiBaseUrlPro : config.openAiBaseUrlStd;
  const selectedApiKey =
    input.tier === 'pro' ? config.chatApiKeyPro : config.chatApiKeyStd;
  const chat = await runDashScopeChat(
    config,
    asr.transcript,
    input.conversationId,
    input.userId,
    input.deviceId,
    input.tier,
    toolContext,
    tracker,
    selectedModel,
    selectedBaseUrl,
    selectedApiKey
  );
  tracker.mark('request', 'succeeded');

  return {
    transcript: asr.transcript,
    replyText: chat.replyText,
    conversationId: chat.conversationId,
    latencyMs: Date.now() - startedAt,
    actions: chat.actions,
    statusTrace: tracker.items,
    asr: {
      provider: config.asrProvider,
      model:
        config.asrProvider === 'stepfun'
          ? config.stepfunAsrModel
          : config.asrModel,
      status: 'succeeded',
      text: asr.transcript,
      request_id: asr.requestId,
      elapsed_ms: asr.elapsedMs,
    },
    functionCalls: chat.functionCalls,
  };
}

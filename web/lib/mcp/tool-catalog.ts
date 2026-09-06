// Single-source tool contract data for the tools shared by every AI surface.
//
// This file must stay dependency-free (type-only imports at most): the Bun
// realtime proxy imports it across the package boundary, so no zod, no
// supabase and no Next.js runtime modules may be pulled in here. The MCP
// registry (tool-registry.ts / tool-extensions.ts) spreads these entries and
// attaches the zod argsSchema + handler; the ESP32 voice pipelines project
// them into OpenAI function definitions (lib/ai-tools/voice-tools.ts).
//
// Contract changes therefore happen here once, and both surfaces move
// together. A contract test in lib/__tests__/ locks the projection.

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  outputSchema?: Record<string, unknown>;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
const IDEMPOTENT_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};
const NON_IDEMPOTENT_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

// The exact set of tools the ESP32 voice chains expose to their LLM. Order
// defines the order sent to the model.
export const VOICE_TOOL_NAMES = [
  'list_authorized_notebooks',
  'create_notebook_note',
  'search_user_problems',
  'get_problem_detail',
  'list_todos',
  'create_todo',
  'update_todo_status',
  'list_authorized_word_decks',
  'create_word_deck',
  'add_word_entry',
  'search_words',
] as const;

export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

export const TOOL_CATALOG = {
  list_authorized_notebooks: {
    name: 'list_authorized_notebooks',
    description:
      '列出当前用户授权给 AI 访问的空白笔记本及各自的读/写权限。读笔记前先调它确认 can_read。',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
  },
  create_notebook_note: {
    name: 'create_notebook_note',
    description:
      '在用户授权 AI 创建内容（can_create）的空白笔记本中新增一条笔记。',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string', description: '目标空白笔记本 ID' },
        title: { type: 'string', description: '笔记标题，最多 120 字符' },
        content: { type: 'string', description: '笔记正文，最多 4000 字符' },
        linked_problem_id: { type: 'string', description: '可选，关联错题 ID' },
        client_request_id: {
          type: 'string',
          description: '可选幂等 ID（8-128 位 URL-safe 字符）',
        },
      },
      required: ['notebook_id', 'title', 'content'],
    },
    annotations: NON_IDEMPOTENT_WRITE,
  },
  search_user_problems: {
    name: 'search_user_problems',
    description: '按标题、题干或解析搜索当前用户自己的错题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        subject_id: { type: 'string', description: '可选科目 ID' },
        limit: { type: 'number', description: '返回数量，最多 5' },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
  },
  get_problem_detail: {
    name: 'get_problem_detail',
    description:
      '读取某道错题的完整内容：壳级题干、各小题（题面、参考答案、分值）、解析文本，以及题图/答案图的临时签名 URL（1 小时有效，题面常在图片里，请务必读取图片）。',
    inputSchema: {
      type: 'object',
      properties: {
        problem_id: { type: 'string', description: '错题 ID' },
      },
      required: ['problem_id'],
    },
    annotations: READ_ONLY,
  },
  list_todos: {
    name: 'list_todos',
    description: '列出当前用户的 Todo。默认只列出 pending。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'completed', 'cancelled', 'all'],
          description: 'Todo 状态过滤，默认 pending',
        },
        subject_id: { type: 'string', description: '可选科目 ID' },
        limit: { type: 'number', description: '返回数量，1-50，默认 20' },
      },
    },
    annotations: READ_ONLY,
  },
  create_todo: {
    name: 'create_todo',
    description: '为当前用户创建一个 Todo。',
    inputSchema: {
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
        problem_set_id: { type: 'string', description: '可选错题集 ID' },
        problem_id: { type: 'string', description: '可选错题 ID' },
        notebook_id: { type: 'string', description: '可选空白笔记本 ID' },
        note_id: { type: 'string', description: '可选 Note ID' },
        word_deck_id: { type: 'string', description: '可选 Word 词库 ID' },
        word_entry_id: { type: 'string', description: '可选 Word 词条 ID' },
      },
      required: ['title'],
    },
    annotations: NON_IDEMPOTENT_WRITE,
  },
  update_todo_status: {
    name: 'update_todo_status',
    description:
      '更新当前用户某个 Todo 的状态（pending/completed/cancelled）。不能删除 Todo。',
    inputSchema: {
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
    annotations: IDEMPOTENT_WRITE,
  },
  list_authorized_word_decks: {
    name: 'list_authorized_word_decks',
    description:
      '列出授权给 AI 的 Word 词库、词条数量和 can_read/can_create/can_update 权限。科目可能为空。',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
  },
  create_word_deck: {
    name: 'create_word_deck',
    description:
      '为当前用户创建一个空白 Word 词库（word_deck，属于笔记本架第三类内容，不是 Notebook）。创建后可用 add_word_entry 添加词条。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '词库名称，最多 80 字符' },
        description: { type: 'string', description: '可选说明，最多 500 字符' },
        subject_id: { type: 'string', description: '可选科目 ID' },
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
    annotations: NON_IDEMPOTENT_WRITE,
  },
  add_word_entry: {
    name: 'add_word_entry',
    description:
      '向已授权 can_create 的用户 Word 词库新增或按规范化词形幂等更新一个词条。',
    inputSchema: {
      type: 'object',
      properties: {
        deck_id: { type: 'string', description: '目标 Word 词库 ID' },
        word: { type: 'string', description: '词形，最多 80 字符' },
        meaning: { type: 'string', description: '释义，最多 1000 字符' },
        phonetic: { type: ['string', 'null'] },
        example: { type: ['string', 'null'] },
        example_translation: { type: ['string', 'null'] },
        part_of_speech: { type: ['string', 'null'] },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '最多 16 个字符串标签',
        },
      },
      required: ['deck_id', 'word', 'meaning'],
    },
    annotations: IDEMPOTENT_WRITE,
  },
  search_words: {
    name: 'search_words',
    description:
      '按前缀或关键词搜索当前用户可访问 Word 词库中的词条，返回词形、释义与个人学习进度摘要。省略关键词时按词形字母序列出。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '可选查询关键词（按词形匹配）' },
        prefix: { type: 'string', description: '可选单词前缀' },
        deck_id: { type: 'string', description: '可选词库 ID' },
        limit: { type: 'number', description: '返回数量，1-20，默认 10' },
      },
    },
    annotations: READ_ONLY,
  },
} satisfies Record<string, ToolCatalogEntry>;

export type CatalogToolName = keyof typeof TOOL_CATALOG;

const VOICE_TOOL_NAME_SET = new Set<string>(VOICE_TOOL_NAMES);

export function isVoiceToolName(name: string): name is VoiceToolName {
  return VOICE_TOOL_NAME_SET.has(name);
}

export function findCatalogTool(name: string): ToolCatalogEntry | undefined {
  return (TOOL_CATALOG as Record<string, ToolCatalogEntry | undefined>)[name];
}

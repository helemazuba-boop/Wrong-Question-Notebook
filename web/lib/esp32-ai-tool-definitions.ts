// Dependency-free ESP32 tool definitions used by the streaming and Flash
// paths. The legacy non-streaming provider keeps a mirrored schema; a parity
// test prevents the two request paths from drifting.

const NOTEBOOK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_authorized_notebooks',
      description: '列出当前用户授权给 AI 访问的空白笔记本及权限。',
      parameters: { type: 'object', properties: {} },
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
      parameters: { type: 'object', properties: {} },
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
          example_translation: {
            type: 'string',
            description: '可选例句翻译',
          },
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
] as const;

export const AI_TOOLS = [
  ...NOTEBOOK_TOOLS,
  ...TODO_TOOLS,
  ...WORD_TOOLS,
] as const;

export const AI_TOOL_PROMPT = [
  '你可以在需要时调用工具读取当前用户的错题、写入用户明确授权给 AI 的空白笔记本，或管理用户的 Todo。',
  '不要声称已经写入笔记或 Todo，除非 create_notebook_note、create_todo 或 update_todo_status 工具返回成功。',
  '错题本只用于读取错题名称和详情；空白笔记本才允许创建笔记。',
  'Todo 是顶层行动清单，不属于笔记本架。Todo 状态只允许 pending、completed、cancelled。',
  '词库是笔记本架中的第三类内容，类型是 word_deck；它不是 Notebook。设备端仍通过 Word 顶层学习页复习词库。',
  '单词学习进度只能由单词学习会话记录；AI 工具不得代写复习结果。',
  '不要声称已经创建词库或添加单词，除非 create_word_deck 或 add_word_to_deck 工具返回成功。',
  '如果没有合适授权或缺少 ID，直接说明需要用户先授权或选择目标。不要编造 notebook_id、problem_id 或 todo_id。',
].join('\n');

export function appendAiToolPrompt(systemPrompt: string): string {
  return systemPrompt.includes(AI_TOOL_PROMPT)
    ? systemPrompt
    : `${systemPrompt}\n\n${AI_TOOL_PROMPT}`;
}

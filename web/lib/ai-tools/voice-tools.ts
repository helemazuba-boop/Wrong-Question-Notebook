// Voice tool definitions for the ESP32 AI pipelines, projected from the
// shared MCP tool catalog (lib/mcp/tool-catalog.ts). This module is
// runtime-neutral on purpose: the realtime proxy imports it across the
// package boundary, using only the catalog and pure calendar/context helpers.
//
// The eight-tool subset is independent of the external 43-tool MCP surface.
// Common definitions come from the catalog; relative Todo time is voice-specific.
// The executor validates input and uses v2 readers plus device-bound receipts.

// Relative, alias-free import: this module is imported across the package
// boundary by the realtime proxy (tsx, no tsconfig paths in its image), so
// every specifier it carries must resolve without the Next.js `@/` alias.
import { TOOL_CATALOG, VOICE_TOOL_NAMES } from '../mcp/tool-catalog';
import { voiceContextPrompt, type VoiceContext } from './voice-context';

export interface VoiceToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const relativeTime = {
  type: 'object',
  properties: {
    date: {
      type: 'string',
      description: 'today/tomorrow/day_after_tomorrow 或 YYYY-MM-DD',
      pattern:
        '^(today|tomorrow|day_after_tomorrow|[0-9]{4}-[0-9]{2}-[0-9]{2})$',
    },
    time: {
      type: 'string',
      pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
      description: '当地 HH:mm；提醒必须明确几点',
    },
    offset_minutes: {
      type: 'integer',
      minimum: 1,
      maximum: 525600,
      description: '多少分钟后；与 date/time 互斥',
    },
  },
  additionalProperties: false,
  oneOf: [
    { required: ['date'], not: { required: ['offset_minutes'] } },
    {
      required: ['offset_minutes'],
      not: { anyOf: [{ required: ['date'] }, { required: ['time'] }] },
    },
  ],
};
export const AI_TOOLS: VoiceToolDefinition[] = VOICE_TOOL_NAMES.map(name => {
  const entry = TOOL_CATALOG[name];
  let parameters: Record<string, unknown> = entry.inputSchema;
  if (name === 'create_notebook_note') {
    // Request identity belongs to the server, never to the model. Keep these
    // bounds in the advertised contract as well as in voice-schemas.ts.
    parameters = {
      type: 'object',
      properties: {
        notebook_id: {
          type: 'string',
          format: 'uuid',
          description: '使用本轮注入的授权空白笔记本 ID',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          pattern: '\\S',
          description: '笔记标题',
        },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          pattern: '\\S',
          description: '笔记正文，纯文本，保留换行',
        },
        linked_problem_id: {
          type: ['string', 'null'],
          format: 'uuid',
          description: '可选，关联已读取的错题 ID',
        },
      },
      required: ['notebook_id', 'title', 'content'],
      additionalProperties: false,
    };
  }
  if (name === 'create_todo') {
    const {
      word_deck_id: _deck,
      word_entry_id: _entry,
      ...properties
    } = parameters.properties as Record<string, unknown>;
    void _deck;
    void _entry;
    parameters = {
      ...parameters,
      properties: { ...properties, due: relativeTime, reminder: relativeTime },
      additionalProperties: false,
      allOf: [
        { not: { required: ['due', 'due_at'] } },
        { not: { required: ['reminder', 'reminder_at'] } },
      ],
    };
  }
  return {
    type: 'function' as const,
    function: {
      name: entry.name,
      description:
        name === 'get_problem_detail'
          ? '读取题干、小题、独立选项、答案来源和缺图状态。图片链接不表示语音模型已看过图片；缺失视觉信息时请明确说明。'
          : entry.description,
      parameters,
    },
  };
});

export const AI_TOOL_PROMPT = [
  '你可以在需要时调用工具读取当前用户的错题、写入用户明确授权给 AI 的空白笔记本，或管理用户的 Todo。',
  '不要声称已经写入笔记或 Todo，除非 create_notebook_note、create_todo 或 update_todo_status 工具返回成功。',
  '错题本只用于读取错题名称和详情；空白笔记本才允许创建笔记。',
  'Todo 是顶层行动清单，不属于笔记本架。Todo 状态只允许 pending、completed、cancelled。',
  '授权笔记本和本轮时间由服务端注入，不需要额外工具查询。错题本通过 list_problem_sets → list_problem_set_problems → get_problem_detail 浏览；按返回游标翻页，不能只用关键词搜索代替浏览。',
  '只新增笔记，不修改错题或已有笔记；不提供词库或查单词工具，也不替用户记录学习成绩。',
  '用户说“明天做”时使用 due:{date:"tomorrow"}；服务端按用户时区取当天结束时间。日期安排不等于提醒，没说提醒不设置 reminder。',
  '用户说“明天提醒我”却没说几点时，先问提醒时间；明确时间用 reminder:{date:"tomorrow",time:"09:00"} 等。多久之后用 offset_minutes。due/reminder 与对应 due_at/reminder_at 不同时传。',
  '图片链接不代表已经看到了图片；缺少选项、图表或官方答案时明确说明，不猜测印刷内容。',
  '时间或写入结果未知时不声称已经保存；同一次工具调用的重试由服务端负责保持同一幂等 ID。',
  '工具失败时根据 error.code 和 message 说明原因，不只说“笔记写入失败”。invalid_arguments 可根据说明修正参数；权限不足时请用户到 WQN 授权，不要反复调用。unknown_outcome 或 operation_in_progress 表示原写入可能已执行，不要另起调用重新新建；说明结果待确认。幂等 ID 由服务端生成，不传 client_request_id。',
  '如果没有合适授权或缺少 ID，直接说明需要用户先授权或选择目标。不要编造 notebook_id、problem_id 或 todo_id。',
].join('\n');

export function appendAiToolPrompt(
  systemPrompt: string,
  context?: VoiceContext
): string {
  const base = systemPrompt.replace(
    /\n?\[WQN_VOICE_CONTEXT\][\s\S]*?\[\/WQN_VOICE_CONTEXT\]/g,
    ''
  );
  const prompt = base.includes(AI_TOOL_PROMPT)
    ? base
    : `${base}\n\n${AI_TOOL_PROMPT}`;
  return context
    ? `${prompt}\n[WQN_VOICE_CONTEXT]\n${voiceContextPrompt(context)}\n[/WQN_VOICE_CONTEXT]`
    : prompt;
}

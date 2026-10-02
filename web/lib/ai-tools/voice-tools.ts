// Voice tool definitions for the ESP32 AI pipelines, projected from the
// shared MCP tool catalog (lib/mcp/tool-catalog.ts). This module is
// dependency-free on purpose: the Bun realtime proxy imports it across the
// package boundary, so it may only pull in the catalog (also dependency-free)
// and use type-only imports otherwise.
//
// Tool contracts (name / description / parameters) live in the catalog, which
// the MCP registry also serves to external clients -- editing them here is
// impossible by construction. A contract test in lib/__tests__/ locks this
// projection to the catalog and the registry.

// Relative, alias-free import: this module is imported across the package
// boundary by the realtime proxy (tsx, no tsconfig paths in its image), so
// every specifier it carries must resolve without the Next.js `@/` alias.
import { TOOL_CATALOG, VOICE_TOOL_NAMES } from '../mcp/tool-catalog';

export interface VoiceToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const AI_TOOLS: VoiceToolDefinition[] = VOICE_TOOL_NAMES.map(name => {
  const entry = TOOL_CATALOG[name];
  return {
    type: 'function' as const,
    function: {
      name: entry.name,
      description: entry.description,
      parameters: entry.inputSchema,
    },
  };
});

export const AI_TOOL_PROMPT = [
  '你可以在需要时调用工具读取当前用户的错题、写入用户明确授权给 AI 的空白笔记本，或管理用户的 Todo。',
  '不要声称已经写入笔记或 Todo，除非 create_notebook_note、create_todo 或 update_todo_status 工具返回成功。',
  '错题本只用于读取错题名称和详情；空白笔记本才允许创建笔记。',
  'Todo 是顶层行动清单，不属于笔记本架。Todo 状态只允许 pending、completed、cancelled。',
  '词库是笔记本架中的第三类内容，类型是 word_deck；它不是 Notebook。设备端仍通过 Word 顶层学习页复习词库。',
  '单词学习进度只能由单词学习会话记录；AI 工具不得代写复习结果。',
  '不要声称已经创建词库或添加单词，除非 create_word_deck 或 add_word_entry 工具返回成功。',
  '如果没有合适授权或缺少 ID，直接说明需要用户先授权或选择目标。不要编造 notebook_id、problem_id 或 todo_id。',
].join('\n');

export function appendAiToolPrompt(systemPrompt: string): string {
  return systemPrompt.includes(AI_TOOL_PROMPT)
    ? systemPrompt
    : `${systemPrompt}\n\n${AI_TOOL_PROMPT}`;
}

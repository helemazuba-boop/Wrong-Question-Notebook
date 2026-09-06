import { describe, expect, it } from 'vitest';
import { AI_TOOLS, AI_TOOL_PROMPT } from '@/lib/ai-tools/voice-tools';
import { VOICE_TOOL_NAMES } from '@/lib/mcp/tool-catalog';
import { findMcpTool } from '@/lib/mcp/tool-registry';
import { applyAiToolSessionConfig } from '@/server/realtime-proxy/src/sessionConfig';
import { injectToolResult } from '@/server/realtime-proxy/src/toolInterceptor';

describe('ESP32 AI tool routing', () => {
  it('exposes exactly the voice catalog subset in catalog order', () => {
    expect(AI_TOOLS.map(tool => tool.function.name)).toEqual([
      ...VOICE_TOOL_NAMES,
    ]);
  });

  it.each([...VOICE_TOOL_NAMES])(
    '%s stays in lockstep with the MCP registry contract',
    name => {
      const projected = AI_TOOLS.find(tool => tool.function.name === name);
      const registryTool = findMcpTool(name);
      expect(projected).toBeDefined();
      expect(registryTool).toBeDefined();
      expect(projected!.function.description).toBe(registryTool!.description);
      expect(projected!.function.parameters).toEqual(registryTool!.inputSchema);
    }
  );

  it('references only renamed-to-catalog tool names in the prompt', () => {
    expect(AI_TOOL_PROMPT).toContain('create_notebook_note');
    expect(AI_TOOL_PROMPT).toContain('create_todo');
    expect(AI_TOOL_PROMPT).toContain('update_todo_status');
    expect(AI_TOOL_PROMPT).toContain('create_word_deck');
    expect(AI_TOOL_PROMPT).toContain('add_word_entry');
    // The pre-unification voice names must not resurface here.
    expect(AI_TOOL_PROMPT).not.toContain('add_word_to_deck');
    expect(AI_TOOL_PROMPT).not.toContain('list_word_decks');
  });

  it('replaces device-provided Flash tools with the authoritative list', () => {
    const first = applyAiToolSessionConfig(
      {
        instructions: 'You are the WQN assistant.',
        tools: [],
        tool_choice: 'none',
      },
      true
    );
    const second = applyAiToolSessionConfig(first, true);

    expect(first.tools).toEqual(AI_TOOLS);
    expect(first.tool_choice).toBe('auto');
    expect(first.instructions).toContain(AI_TOOL_PROMPT);
    expect(second.instructions).toBe(first.instructions);
  });

  it('does not advertise Flash tools when the executor is disabled', () => {
    const session = { instructions: 'base', tools: [] };
    expect(applyAiToolSessionConfig(session, false)).toBe(session);
  });

  it('returns authorized tool data to the Realtime model', () => {
    const sent: string[] = [];
    injectToolResult(
      { sendText: message => sent.push(message) },
      { call_id: 'call-1', name: 'list_todos', raw_args: '{}' },
      {
        ok: true,
        display: 'Reading todos',
        data: { todos: [{ id: 'todo-1', title: '复习数学' }] },
        action: null,
      }
    );

    const toolItem = JSON.parse(sent[0]);
    const output = JSON.parse(toolItem.item.output);
    expect(output.data.todos[0].title).toBe('复习数学');
    expect(JSON.parse(sent[1])).toMatchObject({ type: 'response.create' });
  });

  it('propagates executor errors to the Realtime model output', () => {
    const sent: string[] = [];
    injectToolResult(
      { sendText: message => sent.push(message) },
      { call_id: 'call-2', name: 'create_todo', raw_args: '{}' },
      {
        ok: false,
        display: 'Creating todo failed',
        data: null,
        action: null,
        error: { code: 'invalid_arguments', message: 'title: required' },
      }
    );

    const toolItem = JSON.parse(sent[0]);
    const output = JSON.parse(toolItem.item.output);
    expect(output.ok).toBe(false);
    expect(output.error).toMatchObject({ code: 'invalid_arguments' });
  });
});

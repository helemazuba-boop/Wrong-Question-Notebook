import { describe, expect, it } from 'vitest';
import {
  AI_TOOLS as STREAMING_AI_TOOLS,
  AI_TOOL_PROMPT as STREAMING_AI_TOOL_PROMPT,
} from '@/lib/esp32-ai-tool-definitions';
import {
  AI_TOOLS as LEGACY_AI_TOOLS,
  AI_TOOL_PROMPT as LEGACY_AI_TOOL_PROMPT,
} from '@/lib/esp32-ai-provider';
import { applyAiToolSessionConfig } from '@/server/realtime-proxy/src/sessionConfig';
import { injectToolResult } from '@/server/realtime-proxy/src/toolInterceptor';

describe('ESP32 AI tool routing', () => {
  it('keeps the legacy and streaming tool contracts in parity', () => {
    expect(STREAMING_AI_TOOLS).toEqual(LEGACY_AI_TOOLS);
    expect(STREAMING_AI_TOOL_PROMPT).toBe(LEGACY_AI_TOOL_PROMPT);
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

    expect(first.tools).toEqual(STREAMING_AI_TOOLS);
    expect(first.tool_choice).toBe('auto');
    expect(first.instructions).toContain(STREAMING_AI_TOOL_PROMPT);
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
});

import { describe, expect, it, vi } from 'vitest';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
import { findMcpTool } from '@/lib/mcp/tool-registry';

const createProblemMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/problem-creation-service', async importOriginal => {
  const original =
    await importOriginal<typeof import('@/lib/problem-creation-service')>();
  return {
    ...original,
    createProblem: createProblemMock.mockResolvedValue({
      problem: {
        id: '33333333-3333-4333-8333-333333333333',
        subject_id: '44444444-4444-4444-8444-444444444444',
        title: '基本不等式多选',
        content: '',
        parts: [],
        status: 'needs_review',
        assets: [],
        tags: [],
        created_at: '2026-09-27T00:00:00.000Z',
      },
      extraction: {
        suggest_image_asset: false,
        confidence: undefined,
        warnings: [],
      },
      problem_set_id: null,
      replayed: false,
      quota: null,
    }),
  };
});

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function validArgs(overrides: Record<string, unknown> = {}) {
  return {
    get_prompt: false,
    request_id: 'create_problem_tags_0001',
    title: '基本不等式多选',
    content: '',
    parts: [
      {
        index: 1,
        label: null,
        type: 'multi_choice',
        content: '下列说法正确的是',
        full_marks: 5,
        mcq_choices: [
          { id: 'A', text: 'a' },
          { id: 'B', text: 'b' },
          { id: 'C', text: 'c' },
          { id: 'D', text: 'd' },
        ],
        answer_hint: {
          mcq_correct_choice_id: 'B,C',
          answer_confidence: 'high',
        },
      },
    ],
    suggest_image_asset: false,
    suggested_tags: { new_tag_names: ['判别式法'] },
    confidence: {
      problem_type_confidence: 'high',
      content_quality: 'clear',
      has_math: true,
      warnings: [],
    },
    ...overrides,
  };
}

function toolContext(): McpToolContext {
  return {
    userId: USER_ID,
    apiTokenId: 'token-id',
    conversationId: null,
    deviceId: null,
    origin: 'https://wqn.example.test',
    confirmationPath: '/zh-CN/mcp/idea-confirm',
    supabase: {} as any,
  };
}

describe('MCP create_problem tag alias', () => {
  it('accepts top-level tags and merges them with suggested_tags', async () => {
    const tool = findMcpTool('create_problem')!;
    const parsed = tool.argsSchema.safeParse(
      validArgs({ tags: ['基本不等式', '判别式法'] })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    await tool.handler(toolContext(), parsed.data as Record<string, unknown>);

    const input = createProblemMock.mock.calls[0][2] as {
      suggested_tags: { new_tag_names: string[] };
    };
    expect(input.suggested_tags.new_tag_names).toEqual(
      expect.arrayContaining(['基本不等式', '判别式法'])
    );
  });

  it('keeps the answer hint and leaves suggested_tags untouched without the alias', async () => {
    const tool = findMcpTool('create_problem')!;
    const parsed = tool.argsSchema.safeParse(validArgs());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    await tool.handler(toolContext(), parsed.data as Record<string, unknown>);

    const input = createProblemMock.mock.calls[1][2] as {
      suggested_tags: { new_tag_names: string[] };
      parts: Array<{ answer_hint: { mcq_correct_choice_id: string } }>;
    };
    expect(input.suggested_tags).toEqual({ new_tag_names: ['判别式法'] });
    expect(input.parts[0].answer_hint.mcq_correct_choice_id).toBe('B,C');
  });

  it('rejects a malformed tags value instead of stripping it', () => {
    const tool = findMcpTool('create_problem')!;
    expect(
      tool.argsSchema.safeParse(validArgs({ tags: '基本不等式' })).success
    ).toBe(false);
  });

  it('advertises the alias and the compact choice-answer format', () => {
    const tool = findMcpTool('create_problem')!;
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.tags.type).toBe('array');
    expect(properties.tags.description).toContain('new_tag_names');
    const hintSchema = properties.parts.items.properties.answer_hint.properties;
    expect(hintSchema.mcq_correct_choice_id.description).toContain(
      'multi_choice'
    );
    expect(hintSchema.mcq_correct_choice_id.description).toContain('"BC"');
  });
});

describe('MCP create_problem solution_text', () => {
  it('forwards top-level solution_text to the service', async () => {
    const tool = findMcpTool('create_problem')!;
    const parsed = tool.argsSchema.safeParse(
      validArgs({ solution_text: '思路：先配方再比较。' })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    await tool.handler(toolContext(), parsed.data as Record<string, unknown>);

    const input = createProblemMock.mock.lastCall?.[2] as {
      solution_text: string;
    };
    expect(input.solution_text).toBe('思路：先配方再比较。');
  });

  it('rejects a blank or oversized solution_text instead of stripping it', () => {
    const tool = findMcpTool('create_problem')!;
    expect(
      tool.argsSchema.safeParse(validArgs({ solution_text: '   ' })).success
    ).toBe(false);
    expect(
      tool.argsSchema.safeParse(validArgs({ solution_text: 'x'.repeat(5001) }))
        .success
    ).toBe(false);
  });

  it('advertises solution_text as the persisted 解答 field', () => {
    const tool = findMcpTool('create_problem')!;
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.solution_text.type).toBe('string');
    expect(properties.solution_text.description).toContain('解答');
    expect(properties.solution_text.description).toContain('$$');
  });
});

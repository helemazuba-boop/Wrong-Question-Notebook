import { describe, expect, it, vi } from 'vitest';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
import { findMcpTool } from '@/lib/mcp/tool-registry';

vi.mock('@/lib/problem-creation-service', async importOriginal => {
  const original =
    await importOriginal<typeof import('@/lib/problem-creation-service')>();
  return {
    ...original,
    createProblem: vi.fn().mockResolvedValue({
      problem: {
        id: '33333333-3333-4333-8333-333333333333',
        subject_id: '44444444-4444-4444-8444-444444444444',
        title: 'Prime Numbers',
        content: '',
        parts: [],
        status: 'needs_review',
        assets: [],
        tags: [],
        created_at: '2026-08-08T00:00:00.000Z',
      },
      extraction: {
        suggest_image_asset: false,
        confidence: {
          problem_type_confidence: 'high',
          content_quality: 'clear',
          has_math: false,
          warnings: [],
        },
        warnings: [],
      },
      problem_set_id: null,
      replayed: false,
      quota: null,
    }),
    createProblemFromImages: vi.fn().mockResolvedValue({
      problem: {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Prime Numbers',
      },
      replayed: false,
    }),
  };
});

const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN_ID = '77777777-7777-4777-8777-777777777777';
const PROBLEM_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = 'create_problem_direct_idea_0001';
const IDEA = 'I first tried to list every divisor.';

function validArgs(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    title: 'Prime Numbers',
    content: '',
    parts: [
      {
        index: 1,
        label: null,
        type: 'short_answer',
        content: 'State a prime number.',
        full_marks: null,
        answer_hint: null,
      },
    ],
    suggest_image_asset: false,
    suggested_tags: { new_tag_names: [] },
    confidence: {
      problem_type_confidence: 'high',
      content_quality: 'clear',
      has_math: false,
      warnings: [],
    },
    initial_idea_draft: IDEA,
    ...overrides,
  };
}

function builder(result: { data: unknown; error: unknown }) {
  const chain: any = {};
  for (const method of ['select', 'insert', 'update', 'eq', 'is']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

function challengeContext(options: { existing?: any } = {}) {
  const inserted = builder({
    data: { id: '88888888-8888-4888-8888-888888888888' },
    error: null,
  });
  const lookup = builder({ data: options.existing ?? null, error: null });
  let tableCall = 0;
  const from = vi.fn((table: string) => {
    if (table !== 'problem_initial_idea_mcp_challenges') {
      throw new Error(`Unexpected table: ${table}`);
    }
    tableCall += 1;
    return tableCall === 1 ? lookup : inserted;
  });
  const ctx: McpToolContext = {
    userId: USER_ID,
    apiTokenId: TOKEN_ID,
    origin: 'https://wqn.example.test',
    confirmationPath: '/zh-CN/mcp/idea-confirm',
    supabase: { from } as any,
  };
  return { ctx, lookup, inserted };
}

describe('MCP initial idea challenge', () => {
  it('advertises a machine draft instead of a self-attested human field', () => {
    const tool = findMcpTool('create_problem')!;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('initial_idea_draft');
    expect(properties).not.toHaveProperty('idea_attestation');
    expect(properties).not.toHaveProperty('initial_idea');
    expect(tool.argsSchema.safeParse(validArgs()).success).toBe(true);
    expect(
      tool.argsSchema.safeParse(validArgs({ initial_idea_draft: '   ' }))
        .success
    ).toBe(false);
  });

  it('creates only a short-lived draft challenge and returns exact text', async () => {
    const tool = findMcpTool('create_problem')!;
    const { ctx, inserted } = challengeContext();
    const result = (await tool.handler(ctx, validArgs())) as any;

    expect(result.problem.id).toBe(PROBLEM_ID);
    expect(result.idea_confirmation).toMatchObject({
      status: 'confirmation_required',
      exact_text: IDEA,
      exact_text_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      confirm_url: expect.stringContaining(
        '/zh-CN/mcp/idea-confirm/88888888-8888-4888-8888-888888888888#token='
      ),
      next_step: expect.stringContaining('Stop.'),
    });
    expect(inserted.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        problem_id: PROBLEM_ID,
        source_api_token_id: TOKEN_ID,
        source_request_id: REQUEST_ID,
        proposed_idea: IDEA,
        exact_text_hash: result.idea_confirmation.exact_text_hash,
        challenge_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expires_at: expect.any(String),
      })
    );
    const persisted = inserted.insert.mock.calls[0][0];
    expect(persisted).not.toHaveProperty('challenge_token');
    expect(JSON.stringify(persisted)).not.toContain(
      result.idea_confirmation.confirm_url.split('#token=')[1]
    );
  });

  it('offers the same challenge path for image-created Problems', async () => {
    const tool = findMcpTool('create_problem_from_images')!;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('initial_idea_draft');
    expect(properties).not.toHaveProperty('idea_attestation');
    expect(properties).not.toHaveProperty('initial_idea');

    const { ctx } = challengeContext();
    const result = (await tool.handler(ctx, {
      request_id: 'create_problem_image_idea_0001',
      images: [{ data: 'eA==', mime_type: 'image/png' }],
      initial_idea_draft: IDEA,
    })) as any;
    expect(result.idea_confirmation).toMatchObject({
      status: 'confirmation_required',
      exact_text: IDEA,
      confirm_url: expect.stringContaining('#token='),
    });
  });

  it('rejects request id reuse with a different exact idea', async () => {
    const tool = findMcpTool('create_problem')!;
    const { ctx } = challengeContext({
      existing: {
        id: '88888888-8888-4888-8888-888888888888',
        problem_id: PROBLEM_ID,
        source_api_token_id: TOKEN_ID,
        proposed_idea: 'Different text',
        exact_text_hash: 'a'.repeat(64),
        expires_at: '2026-08-08T00:10:00.000Z',
        consumed_at: null,
      },
    });

    await expect(tool.handler(ctx, validArgs())).rejects.toMatchObject({
      code: 'request_id_reused',
      status: 409,
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { findMcpTool, MCP_TOOLS } from '@/lib/mcp/tool-registry';
import type { McpToolContext } from '@/lib/mcp/tool-registry';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const NOTEBOOK_ID = '55555555-5555-4555-8555-555555555555';
const PROBLEM_ID = '33333333-3333-4333-8333-333333333333';

// Minimal chainable supabase mock: from(table) returns a builder whose every
// method returns itself; awaiting resolves to the queued result for the table.
function makeSupabaseMock(
  results: Record<string, { data: unknown; error: unknown }>
) {
  const rpc = vi.fn((_fn: string) =>
    Promise.resolve(results.__rpc ?? { data: null, error: null })
  );
  function builderFor(table: string) {
    const result = results[table] ?? { data: null, error: null };
    const builder: any = {};
    const chain = [
      'select',
      'insert',
      'update',
      'eq',
      'is',
      'lte',
      'or',
      'order',
      'limit',
      'gt',
    ];
    for (const method of chain) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi.fn(() => Promise.resolve(result));
    builder.single = vi.fn(() => Promise.resolve(result));
    builder.then = (resolve: any, reject: any) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  }
  const from = vi.fn((table: string) => builderFor(table));
  const storage = {
    from: vi.fn(() => ({
      createSignedUrls: vi.fn((paths: string[]) =>
        Promise.resolve({
          data: paths.map(path => ({ path, signedUrl: `signed:${path}` })),
          error: null,
        })
      ),
    })),
  };
  return { from, rpc, storage } as any;
}

function ctxWith(
  results: Record<string, { data: unknown; error: unknown }>
): McpToolContext {
  return { userId: USER_ID, supabase: makeSupabaseMock(results) };
}

describe('MCP_TOOLS registry shape', () => {
  it('exposes exactly the 11 planned tools', () => {
    expect(MCP_TOOLS.map(tool => tool.name).sort()).toEqual(
      [
        'create_notebook_note',
        'create_todo',
        'get_note',
        'get_problem_detail',
        'list_authorized_notebooks',
        'list_notes',
        'list_review_due_problems',
        'list_todos',
        'record_problem_review',
        'search_user_problems',
        'update_todo_status',
      ].sort()
    );
  });

  it('every tool carries a JSON Schema object and a description', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('findMcpTool resolves known names and rejects unknown ones', () => {
    expect(findMcpTool('get_note')?.name).toBe('get_note');
    expect(findMcpTool('drop_all_tables')).toBeUndefined();
  });
});

describe('notebook read gating', () => {
  it('list_notes rejects a notebook without can_read', async () => {
    const ctx = ctxWith({
      notebook_ai_access: {
        data: { can_read: false, can_create: true, can_update: false },
        error: null,
      },
    });
    const tool = findMcpTool('list_notes')!;
    await expect(
      tool.handler(ctx, { notebook_id: NOTEBOOK_ID })
    ).rejects.toMatchObject({ code: 'notebook_permission_denied' });
  });

  it('get_note rejects when no access row exists', async () => {
    const ctx = ctxWith({
      notebook_ai_access: { data: null, error: null },
    });
    const tool = findMcpTool('get_note')!;
    await expect(
      tool.handler(ctx, { notebook_id: NOTEBOOK_ID, note_id: PROBLEM_ID })
    ).rejects.toMatchObject({ code: 'notebook_permission_denied' });
  });
});

describe('record_problem_review', () => {
  const rpcResult = {
    observation_id: '44444444-4444-4444-8444-444444444444',
    problem_id: PROBLEM_ID,
    action: 'correct',
    status: 'mastered',
    schedule: {
      next_review_at: '2026-07-31T16:00:00+00:00',
      interval_days: 3,
      ease_factor: 2.6,
      repetition_number: 2,
    },
    projection_applied: true,
    replayed: false,
  };

  it('maps args onto the RPC with device_id null', async () => {
    const ctx = ctxWith({ __rpc: { data: rpcResult, error: null } });
    const tool = findMcpTool('record_problem_review')!;
    const result = (await tool.handler(ctx, {
      problem_id: PROBLEM_ID,
      action: 'correct',
      request_id: 'mcp_review_request_001',
    })) as { review: { status: string } };

    expect(result.review.status).toBe('mastered');
    const rpc = (ctx.supabase as any).rpc;
    expect(rpc).toHaveBeenCalledWith(
      'record_problem_review_v1',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_device_id: null,
        p_request_id: 'mcp_review_request_001',
        p_problem_id: PROBLEM_ID,
        p_action: 'correct',
      })
    );
  });

  it('generates a 32-hex request_id when the caller omits one', async () => {
    const ctx = ctxWith({ __rpc: { data: rpcResult, error: null } });
    const tool = findMcpTool('record_problem_review')!;
    await tool.handler(ctx, { problem_id: PROBLEM_ID, action: 'correct' });
    const rpc = (ctx.supabase as any).rpc;
    const requestId = rpc.mock.calls[0][1].p_request_id as string;
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('get_problem_detail', () => {
  it('returns per-part statements and signed image urls', async () => {
    const ctx = ctxWith({
      problems: {
        data: {
          id: PROBLEM_ID,
          title: '数列综合',
          content: '',
          solution_text: '见解析',
          status: 'needs_review',
          subjects: { name: '数学' },
          parts: [
            {
              index: 1,
              label: '第(1)问',
              type: 'short_answer',
              full_marks: 6,
              content: '求通项公式',
              correct_answer: 'a_n = 2n',
            },
          ],
          assets: [
            { path: 'user/u/p/a.jpg', display_path: 'user/u/p/a_d.png' },
          ],
          solution_assets: [],
        },
        error: null,
      },
    });
    const tool = findMcpTool('get_problem_detail')!;
    const result = (await tool.handler(ctx, { problem_id: PROBLEM_ID })) as any;

    expect(result.problem.parts).toEqual([
      {
        index: 1,
        label: '第(1)问',
        type: 'short_answer',
        full_marks: 6,
        content_text: '求通项公式',
        correct_answer: 'a_n = 2n',
      },
    ]);
    // display_path wins over path, and the signing mock echoes it back.
    expect(result.problem.problem_images).toEqual([
      { path: 'user/u/p/a_d.png', url: 'signed:user/u/p/a_d.png' },
    ]);
    expect(result.problem.solution_images).toEqual([]);
  });
});

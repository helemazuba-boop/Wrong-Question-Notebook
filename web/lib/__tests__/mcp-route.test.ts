import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/mcp/route';
import { MCP_V2_TOOLS } from '@/lib/mcp/v2-tools';
import { MCP_TOOLS } from '@/lib/mcp/tool-registry';
import { _resetRateLimitStore, consumeRateLimit } from '@/lib/rate-limit';
const { auth, from, rpc } = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/lib/api-token-auth', () => ({ authenticateMcpRequest: auth }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from, rpc }),
}));
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function request(method: string, params?: unknown) {
  return new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'vitest',
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitStore();
  process.env.SITE_URL = 'https://wqn.example.test';
  auth.mockResolvedValue({
    userId: user,
    tokenId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    credentialKind: 'pat',
  });
});
describe('external MCP v2 endpoint', () => {
  it('retains authentication errors and rejects GET', async () => {
    auth.mockResolvedValue(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    );
    expect((await POST(request('tools/list'))).status).toBe(401);
    expect(GET().status).toBe(405);
  });
  it('advertises v2 and workflow instructions with protocol negotiation', async () => {
    const body = await (
      await POST(request('initialize', { protocolVersion: '2025-06-18' }))
    ).json();
    expect(body.result.serverInfo.version).toBe('2.0.0');
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.instructions).toContain('get_workflow_guide');
  });
  it('publishes only strict v2 schemas while preserving the v1 device registry', async () => {
    const body = await (await POST(request('tools/list'))).json();
    expect(body.result.tools).toHaveLength(43);
    expect(MCP_V2_TOOLS).toHaveLength(43);
    expect(MCP_TOOLS).toHaveLength(38);
    for (const t of body.result.tools) {
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.outputSchema.properties.status.enum).toContain(
        'requires_user_action'
      );
    }
    const create = body.result.tools.find(
      (t: any) => t.name === 'create_problem'
    );
    expect(create.inputSchema.properties.get_prompt).toBeUndefined();
    expect(create.inputSchema.required).toContain('request_id');
  });
  it('returns the creation spec without any DB writes and accepts nullable answer fields', async () => {
    const body = await (
      await POST(
        request('tools/call', {
          name: 'get_problem_creation_spec',
          arguments: {},
        })
      )
    ).json();
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.status).toBe('completed');
    expect(
      body.result.structuredContent.data.examples[0].parts[0].answer_hint
    ).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects obsolete creation modes and field aliases before DB access', async () => {
    for (const [name, args] of [
      ['create_problem', { get_prompt: true }],
      ['get_word_detail', { word_id: user }],
      ['update_todo', { todo_id: user, title: 'overwrite' }],
    ]) {
      const body = await (
        await POST(request('tools/call', { name, arguments: args }))
      ).json();
      expect(body.error.code).toBe(-32602);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('uses a typed success envelope for reads', async () => {
    const builder: any = {};
    for (const key of ['select', 'eq', 'is', 'lte', 'order', 'limit'])
      builder[key] = () => builder;
    builder.then = (resolve: any) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    from.mockReturnValue(builder);
    const body = await (
      await POST(request('tools/call', { name: 'list_todos', arguments: {} }))
    ).json();
    expect(body.result.structuredContent).toEqual({
      status: 'completed',
      data: { items: [], next_cursor: null, has_more: false, total: null },
      error: null,
      operation: null,
      next_actions: [],
      warnings: [],
    });
    expect(body.result.isError).toBe(false);
  });
  it('isolates authenticated read, write, control and generic API buckets', async () => {
    for (let i = 0; i < 100; i++)
      consumeRateLimit('mcp:v2:write', user, {
        windowMs: 900000,
        maxRequests: 100,
      });
    expect(
      (
        await POST(
          request('tools/call', { name: 'create_todo', arguments: {} })
        )
      ).status
    ).toBe(429);
    expect((await POST(request('tools/list'))).status).toBe(200);
    for (let i = 0; i < 300; i++)
      consumeRateLimit('mcp:v2:read', user, {
        windowMs: 900000,
        maxRequests: 300,
      });
    expect(
      (await POST(request('tools/call', { name: 'list_todos', arguments: {} })))
        .status
    ).toBe(429);
    expect(
      (
        await POST(
          request('tools/call', { name: 'get_workflow_guide', arguments: {} })
        )
      ).status
    ).toBe(200);
  });
});

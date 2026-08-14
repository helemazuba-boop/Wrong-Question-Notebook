import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/mcp/route';
import { MCP_TOOLS, findMcpTool } from '@/lib/mcp/tool-registry';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { mockAuthenticate, mockFrom, mockRpc } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('@/lib/api-token-auth', () => ({
  authenticateApiToken: mockAuthenticate,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function mcpRequest(body: unknown, url = 'http://localhost/api/mcp') {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer wqn_mcp_${'a'.repeat(64)}`,
      'content-type': 'application/json',
      'user-agent': 'vitest-mcp',
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitStore();
  process.env.SITE_URL = 'https://wqn.example.test';
  mockAuthenticate.mockResolvedValue({ userId: USER_ID, tokenId: TOKEN_ID });
});

describe('/api/mcp JSON-RPC dispatch', () => {
  it('returns 401 straight from auth when the token is rejected', async () => {
    mockAuthenticate.mockResolvedValue(
      NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'nope' } },
        { status: 401 }
      )
    );
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    );
    expect(res.status).toBe(401);
  });

  it('initialize echoes a supported protocol version', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.protocolVersion).toBe('2025-06-18');
    expect(json.result.serverInfo.name).toBe('wqn-mcp');
    expect(json.result.capabilities).toEqual({ tools: {} });
  });

  it('initialize falls back to the default version for unknown requests', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      })
    );
    const json = await res.json();
    expect(json.result.protocolVersion).toBe('2025-03-26');
  });

  it('notifications/initialized answers 202 with no body', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
    );
    expect(res.status).toBe(202);
  });

  it('tools/list returns the full registry with schemas', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    );
    const json = await res.json();
    expect(json.result.tools).toHaveLength(MCP_TOOLS.length);
    for (const tool of json.result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema.type).toBe('object');
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: false,
        idempotentHint: expect.any(Boolean),
      });
    }
  });

  it('tools/call returns text and structured content on success', async () => {
    const builder: any = {};
    for (const method of ['select', 'eq', 'is', 'lte', 'order', 'limit']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    mockFrom.mockReturnValue(builder);

    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'list_todos', arguments: {} },
      })
    );
    const json = await res.json();
    expect(json.result.isError).toBe(false);
    expect(JSON.parse(json.result.content[0].text)).toEqual({ todos: [] });
    expect(json.result.structuredContent).toEqual({ todos: [] });
  });

  it('create_problem returns its extraction prompt without database access', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: {
          name: 'create_problem',
          arguments: { get_prompt: true },
        },
      })
    );
    const json = await res.json();
    expect(json.result.isError).toBe(false);
    expect(json.result.structuredContent).toMatchObject({
      prompt: expect.stringContaining(
        'Extract faithfully. Do NOT solve the problem.'
      ),
      next_step: expect.stringContaining('call create_problem again'),
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('does not derive confirmation links from the request Host', async () => {
    const handler = vi
      .spyOn(findMcpTool('create_problem')!, 'handler')
      .mockImplementation(async ctx => ({ confirmation_origin: ctx.origin }));

    const res = await POST(
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 33,
          method: 'tools/call',
          params: {
            name: 'create_problem',
            arguments: { get_prompt: true },
          },
        },
        'https://attacker.example/api/mcp'
      )
    );
    const json = await res.json();
    expect(json.result.structuredContent.confirmation_origin).toBe(
      'https://wqn.example.test'
    );
    expect(json.result.structuredContent.confirmation_origin).not.toContain(
      'attacker.example'
    );
    handler.mockRestore();
  });

  it('unknown methods return -32601', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 4, method: 'resources/list' })
    );
    const json = await res.json();
    expect(json.error.code).toBe(-32601);
  });

  it('unknown tools return -32602', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'drop_all_tables', arguments: {} },
      })
    );
    const json = await res.json();
    expect(json.error.code).toBe(-32602);
  });

  it('missing required arguments return -32602 with the offending path', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'get_note', arguments: { notebook_id: 'nb-1' } },
      })
    );
    const json = await res.json();
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain('note_id');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('injection-shaped ids are rejected before the handler runs', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'get_problem_detail',
          arguments: { problem_id: "1' OR '1'='1" },
        },
      })
    );
    const json = await res.json();
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain('problem_id');
    // The rejected value itself must not be echoed back.
    expect(json.error.message).not.toContain("OR '1'");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('oversize payloads return -32602', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'create_notebook_note',
          arguments: {
            notebook_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            title: 'ok',
            content: 'x'.repeat(4001),
          },
        },
      })
    );
    const json = await res.json();
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain('content');
  });

  it('non-object arguments return -32602', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'list_todos', arguments: ['pending'] },
      })
    );
    const json = await res.json();
    expect(json.error.code).toBe(-32602);
  });

  it('malformed JSON returns -32700 with HTTP 400', async () => {
    const req = new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer wqn_mcp_${'a'.repeat(64)}`,
        'content-type': 'application/json',
        'user-agent': 'vitest-mcp',
        'x-forwarded-for': '127.0.0.1',
      },
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe(-32700);
  });

  it('tool failures surface as isError content, not RPC errors', async () => {
    // list_notes hits the can_read gate: mock an access row that denies read.
    const builder: any = {};
    for (const method of ['select', 'eq', 'is', 'maybeSingle']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve({
        data: { can_read: false, can_create: false, can_update: false },
        error: null,
      })
    );
    mockFrom.mockReturnValue(builder);

    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'list_notes',
          arguments: { notebook_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain('notebook_permission_denied');
    expect(json.result.structuredContent.error).toEqual({
      code: 'notebook_permission_denied',
      message: expect.any(String),
      retryable: false,
    });
  });

  it('GET is rejected with 405 (stateless server, no SSE)', async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });
});

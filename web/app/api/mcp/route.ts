// External MCP v2. ESP32 voice continues to execute the separate v1 registry.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withSecurity } from '@/lib/security-middleware';
import { authenticateMcpRequest } from '@/lib/api-token-auth';
import { getAppOrigin } from '@/lib/app-origin';
import { createServiceClient } from '@/lib/supabase-utils';
import { consumeRateLimit } from '@/lib/rate-limit';
import {
  callV2Tool,
  findV2Tool,
  MCP_V2_TOOLS,
  failure,
} from '@/lib/mcp/v2-tools';
import {
  DIRECT_WRITE_TOOLS,
  EDIT_TOOLS,
  MCP_V2_INSTRUCTIONS,
  MCP_V2_VERSION,
  type McpV2ToolName,
} from '@/lib/mcp/v2-contracts';
export const runtime = 'nodejs';
export const maxDuration = 120;
const versions = ['2025-06-18', '2025-03-26'];
const RpcRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const rpcResult = (id: string | number | null, result: unknown) =>
  NextResponse.json({ jsonrpc: '2.0', id, result });
const rpcError = (
  id: string | number | null,
  code: number,
  message: string,
  status = 200
) =>
  NextResponse.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status }
  );
async function handleMcp(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateMcpRequest(req);
  if (auth instanceof NextResponse) return auth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const parsed = RpcRequestSchema.safeParse(body);
  if (!parsed.success) return rpcError(null, -32600, 'Invalid request', 400);
  const { id = null, method, params = {} } = parsed.data;
  const name = String(params.name ?? '') as McpV2ToolName;
  const category =
    method !== 'tools/call' ||
    [
      'get_workflow_guide',
      'get_problem_creation_spec',
      'get_operation_status',
      'resume_operation',
    ].includes(name)
      ? 'control'
      : DIRECT_WRITE_TOOLS.has(name) || EDIT_TOOLS[name]
        ? 'write'
        : 'read';
  const budget = consumeRateLimit(`mcp:v2:${category}`, auth.userId, {
    windowMs: 15 * 60_000,
    maxRequests: category === 'read' ? 300 : 100,
  });
  if (!budget.ok)
    return NextResponse.json(
      {
        error: {
          code: 'mcp_rate_limited',
          message: 'MCP budget exceeded',
          retryable: true,
        },
      },
      { status: 429, headers: { 'Retry-After': String(budget.retryAfter) } }
    );
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: versions.includes(String(params.protocolVersion))
          ? params.protocolVersion
          : versions[1],
        capabilities: { tools: {} },
        serverInfo: { name: 'wqn-mcp', version: MCP_V2_VERSION },
        instructions: MCP_V2_INSTRUCTIONS,
      });
    case 'notifications/initialized':
      return new NextResponse(null, { status: 202 });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: MCP_V2_TOOLS.map(
          ({ name, description, inputSchema, outputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            outputSchema,
            annotations,
          })
        ),
      });
    case 'tools/call': {
      const tool = findV2Tool(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = tool.argsSchema.safeParse(params.arguments ?? {});
      if (!args.success)
        return rpcError(
          id,
          -32602,
          `Invalid params: ${args.error.issues
            .slice(0, 3)
            .map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`)
            .join('; ')}`
        );
      const result = await callV2Tool(
        {
          userId: auth.userId,
          apiTokenId: auth.tokenId,
          credentialKind: auth.credentialKind,
          origin: getAppOrigin(),
          conversationId: null,
          deviceId: null,
          supabase: createServiceClient(),
        },
        name,
        args.data as Record<string, unknown>
      );
      const output = tool.resultSchema.safeParse(result);
      const safe = output.success
        ? output.data
        : {
            ...failure({ code: 'output_contract_error' }),
            status: result.operation ? 'unknown' : 'failed',
            operation: result.operation,
            next_actions: result.operation
              ? [
                  {
                    kind: 'call_tool',
                    tool_name: 'get_operation_status',
                    arguments: {
                      tool_name: name,
                      request_id: result.operation.request_id,
                    },
                    description: '回读结果异常，查询原操作状态。',
                  },
                ]
              : [],
          };
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(safe) }],
        structuredContent: safe,
        isError: ['failed', 'unknown'].includes(safe.status),
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
export const POST = withSecurity(handleMcp, {
  enableRateLimit: false,
  enableRequestValidation: false,
});
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}

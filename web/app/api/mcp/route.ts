// Public MCP endpoint: stateless Streamable HTTP (JSON-RPC 2.0 over POST).
//
// External AI clients (Claude Desktop etc.) authenticate with a personal
// access token generated on the web MCP page. The server is deliberately
// stateless -- every tools/call is a fast request/response, so no SSE stream
// and no session store (the MCP spec allows a server that answers each POST
// with a single JSON body and rejects GET).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withSecurity } from '@/lib/security-middleware';
import { authenticateApiToken } from '@/lib/api-token-auth';
import { createServiceClient } from '@/lib/supabase-utils';
import { logger } from '@/lib/logger';
import {
  findMcpTool,
  MCP_TOOLS,
  type McpToolContext,
} from '@/lib/mcp/tool-registry';

export const runtime = 'nodejs';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'wqn-mcp', version: '1.0.0' };

const RpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

function rpcResult(id: string | number | null, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  status = 200
) {
  // JSON-RPC errors ride on HTTP 200 unless the transport itself failed.
  return NextResponse.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status }
  );
}

// Tool failures surface inside the tools/call result (isError) so the AI can
// read the reason and continue the conversation instead of aborting.
function toolErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return typeof code === 'string' ? `${code}: ${message}` : message;
    }
  }
  return 'Tool execution failed';
}

function toolErrorData(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    return {
      code:
        typeof candidate.code === 'string'
          ? candidate.code
          : 'tool_execution_failed',
      message:
        typeof candidate.message === 'string'
          ? candidate.message
          : 'Tool execution failed',
      retryable: Boolean(candidate.retryable),
    };
  }
  return {
    code: 'tool_execution_failed',
    message: 'Tool execution failed',
    retryable: false,
  };
}

// Summarise zod issues as "path: reason" pairs without echoing back the
// offending values themselves.
function invalidParamsMessage(error: z.ZodError): string {
  const details = error.issues
    .slice(0, 3)
    .map(issue => {
      const path = issue.path.join('.') || 'arguments';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return `Invalid params: ${details}`;
}

async function handleMcp(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateApiToken(req);
  if (auth instanceof NextResponse) return auth;

  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const parsed = RpcRequestSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rpcError(null, -32600, 'Invalid request', 400);
  }
  const { id = null, method, params = {} } = parsed.data;

  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized':
      // Notification: acknowledge with an empty 202 body per spec.
      return new NextResponse(null, { status: 202 });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: MCP_TOOLS.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? {
            type: 'object',
            additionalProperties: true,
          },
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      });
    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const tool = findMcpTool(toolName);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      // Per-tool zod gate: reject wrong types, out-of-range sizes and
      // malformed ids before any handler logic runs.
      const parsedArgs = tool.argsSchema.safeParse(params.arguments ?? {});
      if (!parsedArgs.success) {
        return rpcError(id, -32602, invalidParamsMessage(parsedArgs.error));
      }
      const args = parsedArgs.data as Record<string, unknown>;
      const ctx: McpToolContext = {
        userId: auth.userId,
        supabase: createServiceClient(),
      };
      try {
        const data = await tool.handler(ctx, args);
        const structuredContent =
          data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : { value: data };
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent,
          isError: false,
        });
      } catch (error) {
        logger.warn('MCP tool call failed', {
          component: 'McpEndpoint',
          action: 'toolsCall',
          toolName,
          userId: auth.userId,
          message: toolErrorText(error),
        });
        const errorData = toolErrorData(error);
        return rpcResult(id, {
          content: [{ type: 'text', text: toolErrorText(error) }],
          structuredContent: { error: errorData },
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export const POST = withSecurity(handleMcp, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  // Generic pattern scanning stays off (note/problem text is arbitrary user
  // prose); tools/call arguments are validated per tool with zod instead.
  enableRequestValidation: false,
});

export function GET() {
  // Stateless server: no SSE stream is offered.
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}

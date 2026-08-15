// /api/esp32/ai/execute-tool/route.ts
//
// Internal-call-only endpoint that runs a single AI tool against the
// authoritative state in Supabase. The upstream caller is expected to be
// the WQN Flash Realtime relay (web/server/realtime-proxy/), which gates
// access via `WQN_REALTIME_PROXY_SECRET` and forwards the original device
// userId. This file deliberately reuses the existing `buildAiToolExecutor`
// so we have exactly one source of truth for the 12 tool implementations.
//
// Why this endpoint exists:
//   The Flash mode WS pipeline passes through the OpenAI Realtime upstream
//   and intercepts `response.function_call_arguments.done`. The relay server
//   itself does not carry the Supabase service-role credentials for tool
//   mutations, so it posts back here for execution and only forwards the
//   final `conversation.item.create` message upstream.
//
// Auth model:
//   - Bearer: `${WQN_REALTIME_PROXY_SECRET}` (a 64+ char random secret
//     shared between the Bun process and the Next.js container only).
//   - HMAC-SHA256 binds a short-lived timestamp to the exact request body.
//   - Body carries both device and user IDs; this route verifies their binding
//     against esp32_devices before any service-role operation.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  buildAiToolExecutor,
  type V2ToolContext,
} from '../transcribe-chat/v2-tools';
import { createApiErrorResponse } from '@/lib/common-utils';
import { logger } from '@/lib/logger';
import { verifyInternalRequest } from '@/lib/internal-request-auth';
import { createServiceClient } from '@/lib/supabase-utils';

export const runtime = 'nodejs';

const TOOL_NAMES = [
  'list_authorized_notebooks',
  'create_notebook_note',
  'search_user_problems',
  'get_problem_detail',
  'list_todos',
  'create_todo',
  'update_todo_status',
  'list_word_decks',
  'create_word_deck',
  'add_word_to_deck',
  'search_words',
] as const;

const BodySchema = z.object({
  request_id: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  user_id: z.string().uuid(),
  tool_name: z.enum(TOOL_NAMES),
  raw_args: z
    .string()
    .max(64 * 1024)
    .default(''),
  conversation_id: z.string().uuid().nullable().optional(),
  device_id: z.string().uuid(),
});

function unauthorized(message: string) {
  return NextResponse.json(
    { success: false, error: { code: 'unauthorized', message } },
    { status: 401 }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Internal-secret check. The secret must be a non-empty value or we
  //    refuse every request, never silently allowing an empty default.
  const expected = process.env.WQN_REALTIME_PROXY_SECRET;
  if (!expected || expected.length < 32) {
    logger.error('WQN_REALTIME_PROXY_SECRET missing or too short', undefined, {
      component: 'FlashProxy.ExecuteTool',
      action: 'guard',
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'disabled', message: 'Relay misconfigured' },
      },
      { status: 503 }
    );
  }
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${expected}`) {
    return unauthorized('Bad proxy credentials');
  }

  const allowedHost = process.env.WQN_INTERNAL_API_ALLOWED_HOST;
  if (allowedHost && req.headers.get('host') !== allowedHost) {
    return unauthorized('Invalid internal host');
  }

  const rawBody = await req.text();
  if (rawBody.length > 70 * 1024) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'bad_request', message: 'Body too large' },
      },
      { status: 413 }
    );
  }
  if (
    !verifyInternalRequest({
      secret: expected,
      timestamp: req.headers.get('x-wqn-internal-timestamp'),
      signature: req.headers.get('x-wqn-internal-signature'),
      body: rawBody,
    })
  ) {
    return unauthorized('Invalid internal signature');
  }

  // 2. Body validation. We keep this strict; the relay has already sanitised
  //    the upstream call_args chunk before posting.
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'bad_request', message: 'Invalid body' },
      },
      { status: 400 }
    );
  }

  const svc = createServiceClient();
  const { data: device, error: deviceError } = await svc
    .from('esp32_devices')
    .select('id')
    .eq('id', body.device_id)
    .eq('user_id', body.user_id)
    .maybeSingle();
  if (deviceError || !device) {
    return unauthorized('Device context mismatch');
  }

  // 3. Execute via the same builder the SSE v2 streaming path uses.
  const ctx: V2ToolContext = {
    userId: body.user_id,
    conversationId: body.conversation_id ?? null,
    deviceId: body.device_id ?? null,
  };
  let result;
  try {
    const executor = buildAiToolExecutor(ctx);
    result = await executor(body.tool_name, body.raw_args);
  } catch (err) {
    logger.error('execute-tool threw', err, {
      component: 'FlashProxy.ExecuteTool',
      action: 'execute',
      toolName: body.tool_name,
      userId: ctx.userId,
    });
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'internal',
          message: createApiErrorResponse('Tool execution failed').error,
        },
      },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      success: true,
      result: {
        ok: result.ok,
        display: result.display,
        data: result.data ?? null,
        action: result.action ?? null,
      },
    },
    { status: 200 }
  );
}

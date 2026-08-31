import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createSseResponse } from '@/lib/ai-stream';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { relayOpenCodeEvents } from '@/lib/opencode-agent-events';
import {
  listOpenCodeSessions,
  openOpenCodeEventStream,
  OpenCodeGatewayError,
  resolveOpenCodeBinding,
  submitOpenCodePrompt,
} from '@/lib/opencode-agent-gateway';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RunBody = z.object({
  text: z.string().trim().min(1).max(4096),
  confirmed: z.literal(true),
});

function jsonError(
  code: string,
  message: string,
  status: number
): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status }
  );
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await context.params;
  if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) {
    return jsonError('invalid_session', 'Invalid OpenCode session id', 422);
  }

  let parsed: z.infer<typeof RunBody>;
  try {
    parsed = RunBody.parse(await req.json());
  } catch {
    return jsonError(
      'confirmation_required',
      'An explicit on-device confirmation is required',
      422
    );
  }

  try {
    const binding = resolveOpenCodeBinding(auth.userId);
    // Session IDs are client-controlled. Re-resolve ownership at action time
    // against the binding-scoped authoritative list; do not trust the ID or
    // the OpenCode directory header/query alone.
    const ownedSessions = await listOpenCodeSessions(binding, 12);
    if (!ownedSessions.some(session => session.id === id)) {
      return jsonError(
        'session_not_found',
        'OpenCode session is not available for this binding',
        404
      );
    }
    // Subscribe before submitting so short tasks cannot complete in the gap
    // between prompt_async and GET /event.
    const upstream = await openOpenCodeEventStream(binding, req.signal);
    try {
      await submitOpenCodePrompt(binding, id, parsed.text);
    } catch (error) {
      await upstream.body?.cancel().catch(() => undefined);
      throw error;
    }
    const response = createSseResponse(async writer => {
      writer.emit('agent.accepted', { session_id: id });
      try {
        await relayOpenCodeEvents({
          upstream: upstream.body!,
          writer,
          sessionId: id,
        });
      } catch {
        writer.emit('agent.error', {
          session_id: id,
          message: 'OpenCode event stream disconnected',
        });
      }
    });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    if (error instanceof OpenCodeGatewayError) {
      return jsonError(error.code, error.message, error.status);
    }
    return jsonError('upstream_error', 'OpenCode gateway failed', 502);
  }
}

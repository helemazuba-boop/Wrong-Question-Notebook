import { NextRequest, NextResponse } from 'next/server';

import { createSseResponse } from '@/lib/ai-stream';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { relayOpenCodeEvents } from '@/lib/opencode-agent-events';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import {
  assertOpenCodeSessionAccess,
  createOpenCodePendingProbe,
  openOpenCodeEventStream,
  OpenCodeGatewayError,
  OpenCodeSessionAccessError,
  resolveOpenCodeBinding,
} from '@/lib/opencode-agent-gateway';

export const runtime = 'nodejs';
// Read-only re-attach to a session's event stream. This is how the device
// regains visibility of a run that outlived a previous connection; no prompt
// is submitted here.
export const maxDuration = 1800;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof NextResponse) return auth;
  const limited = enforceAgentRateLimit(auth.deviceId, 'events');
  if (limited) return limited;
  const { id } = await context.params;
  if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'invalid_session',
          message: 'Invalid OpenCode session id',
        },
      },
      { status: 422 }
    );
  }

  try {
    const binding = resolveOpenCodeBinding(auth.userId);
    await assertOpenCodeSessionAccess(binding, id);
    const upstream = await openOpenCodeEventStream(binding, req.signal);
    const response = createSseResponse(async writer => {
      writer.emit('agent.attached', { session_id: id });
      try {
        await relayOpenCodeEvents({
          upstream: upstream.body!,
          writer,
          sessionId: id,
          mode: 'observe',
          // v2's event stream is live-only: an idle session sends nothing at
          // all. The probe is what ends this attach when the run it watches is
          // over, and what delivers asks the upstream never sends as events.
          probe: createOpenCodePendingProbe(binding),
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
    if (error instanceof OpenCodeSessionAccessError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'session_not_found',
            message: 'OpenCode session is not available for this binding',
          },
        },
        { status: 404 }
      );
    }
    if (error instanceof OpenCodeGatewayError) {
      return NextResponse.json(
        {
          success: false,
          error: { code: error.code, message: error.message },
        },
        { status: error.status }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: { code: 'upstream_error', message: 'OpenCode gateway failed' },
      },
      { status: 502 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createSseResponse } from '@/lib/ai-stream';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { relayOpenCodeEvents } from '@/lib/opencode-agent-events';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import { parseOpenCodeDetail } from '@/lib/opencode-agent-detail';
import {
  assertOpenCodeSessionAccess,
  createOpenCodePendingProbe,
  openOpenCodeEventStream,
  OpenCodeGatewayError,
  OpenCodeSessionAccessError,
  resolveOpenCodeBinding,
  submitOpenCodePrompt,
} from '@/lib/opencode-agent-gateway';

export const runtime = 'nodejs';
// Self-hosted `next start` ignores this hint; it documents the gateway's
// event absolute cap and matches the default WQN_OPENCODE_EVENT_MAX_DURATION_MS.
export const maxDuration = 1800;

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
  const limited = enforceAgentRateLimit(auth.deviceId, 'run');
  if (limited) return limited;
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

  // The tier this run's stream should be projected at; an absent or malformed
  // parameter stays at full (pre-tier firmware).
  const detail = parseOpenCodeDetail(req.nextUrl.searchParams.get('detail'));

  try {
    const binding = resolveOpenCodeBinding(auth.userId);
    await assertOpenCodeSessionAccess(binding, id);
    // Subscribe before submitting, so a run that finishes faster than the
    // subscribe round trip cannot slip through the gap unwatched.
    const upstream = await openOpenCodeEventStream(binding, req.signal);
    const response = createSseResponse(async writer => {
      // The accepted frame is written before the prompt request is issued, and
      // the prompt is submitted inside the SSE body rather than before the
      // response is returned, so a rejected submit reaches the device as an
      // agent.error frame instead of an HTTP error the firmware would have to
      // translate. v2's /prompt is a fire-and-forget submit -- measured
      // against the live server it answers in milliseconds to ~2s with a
      // `{data: user message}` envelope while the run streams on /api/event --
      // so the relay starts right after it either way.
      writer.emit('agent.accepted', { session_id: id });
      try {
        await submitOpenCodePrompt(binding, id, parsed.text, req.signal);
      } catch {
        await upstream.body?.cancel().catch(() => undefined);
        writer.emit('agent.error', {
          session_id: id,
          message: 'OpenCode rejected the prompt',
        });
        return;
      }
      try {
        await relayOpenCodeEvents({
          upstream: upstream.body!,
          writer,
          sessionId: id,
          mode: 'run',
          detail,
          // v2 has no permission or question events: the only way an ask
          // reaches the device is this poll. Run mode must not use the probe's
          // outcome read — a running agent can be silent for minutes.
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
      return jsonError(
        'session_not_found',
        'OpenCode session is not available for this binding',
        404
      );
    }
    if (error instanceof OpenCodeGatewayError) {
      return jsonError(error.code, error.message, error.status);
    }
    return jsonError('upstream_error', 'OpenCode gateway failed', 502);
  }
}

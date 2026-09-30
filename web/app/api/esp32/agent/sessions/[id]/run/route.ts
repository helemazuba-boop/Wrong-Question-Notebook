import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createSseResponse } from '@/lib/ai-stream';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import {
  relayOpenCodeEvents,
  type OpenCodeRelayOutcome,
} from '@/lib/opencode-agent-events';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import { parseOpenCodeDetail } from '@/lib/opencode-agent-detail';
import {
  claimAgentRunRequest,
  completeAgentRunRequest,
  fingerprintAgentRunRequest,
} from '@/lib/opencode-agent-run-idempotency';
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
  // Idempotency key, same 16-hex shape as the voice turn ids. Optional on
  // purpose: firmware that predates it keeps the exact pre-P2 behaviour (no
  // ledger row, no claim, no replay).
  request_id: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
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

/**
 * Where a relay outcome lands in the idempotency ledger. A null return means
 * "no terminal write": the device disconnected or an observe attach ended
 * without a terminator, so the run may still be executing upstream and the row
 * must stay in_flight for a same-id retry to attach to. Writing a terminal
 * state here would make that retry skip a run that is still going; the lease
 * is what retires a row whose route never came back.
 */
function terminalLedgerWrite(
  outcome: OpenCodeRelayOutcome
): { state: 'completed' | 'failed'; errorCode: string | null } | null {
  switch (outcome) {
    case 'succeeded':
      return { state: 'completed', errorCode: null };
    case 'interrupted':
      return { state: 'failed', errorCode: 'interrupted' };
    case 'failed':
      return { state: 'failed', errorCode: 'execution_failed' };
    case 'disposed':
      return { state: 'failed', errorCode: 'server_disposed' };
    case 'upstream_ended':
      return { state: 'failed', errorCode: 'stream_incomplete' };
    case 'observe_ended':
    case 'client_closed':
      return null;
  }
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
  const requestId = parsed.request_id ?? null;

  try {
    const binding = resolveOpenCodeBinding(auth.userId);
    await assertOpenCodeSessionAccess(binding, id);

    // The claim happens before the SSE response exists, so a conflict is an
    // HTTP JSON answer the device can act on immediately. Only claimed/stale
    // rows are this invocation's to finish; attached replays are read-only.
    let ownsClaim = false;
    if (requestId !== null) {
      const claim = await claimAgentRunRequest({
        deviceId: auth.deviceId,
        requestId,
        sessionId: id,
        fingerprint: fingerprintAgentRunRequest({
          sessionId: id,
          text: parsed.text,
          detail,
        }),
      });
      switch (claim.kind) {
        case 'conflict':
          return jsonError(
            'request_id_conflict',
            'This request id was already used for a different prompt',
            409
          );
        case 'busy':
          return jsonError(
            'run_in_progress',
            'Another run is already in flight on this device',
            409
          );
        case 'unavailable':
          return jsonError(
            'run_idempotency_unavailable',
            'Run idempotency store is unavailable',
            503
          );
        case 'completed':
          // The run already finished: hand the device the same terminator a
          // live run would have ended with, without resubmitting anything.
          return createSseResponse(async writer => {
            writer.emit('agent.attached', { session_id: id });
            writer.emit('agent.status', { session_id: id, status: 'idle' });
          });
        case 'failed':
          return createSseResponse(async writer => {
            writer.emit('agent.attached', { session_id: id });
            // The device renders `message`; the stored code travels inside it
            // because the agent.error frame has no code field.
            writer.emit('agent.error', {
              session_id: id,
              message: `上次运行未完成（${claim.errorCode ?? 'unknown'}）`,
            });
            writer.emit('agent.status', { session_id: id, status: 'idle' });
          });
        case 'attached': {
          // A retry of a run that is still in flight: watch it, never
          // resubmit. The upstream stream is live-only, exactly like the
          // events route.
          const upstream = await openOpenCodeEventStream(binding, req.signal);
          return createSseResponse(async writer => {
            writer.emit('agent.attached', { session_id: id });
            try {
              await relayOpenCodeEvents({
                upstream: upstream.body!,
                writer,
                sessionId: id,
                mode: 'run',
                detail,
                probe: createOpenCodePendingProbe(binding),
              });
            } catch {
              writer.emit('agent.error', {
                session_id: id,
                message: 'OpenCode event stream disconnected',
              });
            }
          });
        }
        case 'claimed':
        case 'stale':
          ownsClaim = true;
          break;
      }
    }

    let upstream: Response;
    try {
      upstream = await openOpenCodeEventStream(binding, req.signal);
    } catch (error) {
      if (ownsClaim && requestId !== null) {
        // Nothing was submitted, so a retry must not find an in_flight row
        // and attach to a run that does not exist.
        await completeAgentRunRequest({
          deviceId: auth.deviceId,
          requestId,
          state: 'failed',
          errorCode: 'upstream_unavailable',
        });
      }
      throw error;
    }

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
      let terminal: ReturnType<typeof terminalLedgerWrite> = null;
      try {
        try {
          await submitOpenCodePrompt(binding, id, parsed.text, req.signal);
        } catch {
          await upstream.body?.cancel().catch(() => undefined);
          writer.emit('agent.error', {
            session_id: id,
            message: 'OpenCode rejected the prompt',
          });
          terminal = { state: 'failed', errorCode: 'submit_rejected' };
          return;
        }
        try {
          terminal = terminalLedgerWrite(
            await relayOpenCodeEvents({
              upstream: upstream.body!,
              writer,
              sessionId: id,
              mode: 'run',
              detail,
              // v2 has no permission or question events: the only way an ask
              // reaches the device is this poll. Run mode must not use the
              // probe's outcome read — a running agent can be silent for
              // minutes.
              probe: createOpenCodePendingProbe(binding),
            })
          );
        } catch {
          writer.emit('agent.error', {
            session_id: id,
            message: 'OpenCode event stream disconnected',
          });
          terminal = { state: 'failed', errorCode: 'stream_disconnected' };
        }
      } finally {
        if (ownsClaim && requestId !== null && terminal !== null) {
          await completeAgentRunRequest({
            deviceId: auth.deviceId,
            requestId,
            state: terminal.state,
            errorCode: terminal.errorCode,
          });
        }
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

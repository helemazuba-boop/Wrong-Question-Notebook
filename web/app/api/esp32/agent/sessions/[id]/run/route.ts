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
import { abandonQuestionSequences } from '@/lib/opencode-agent-question-sequence';

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
 * "no terminal write": an observe attach ended without a terminator, so the
 * run may still be executing upstream and the row must stay in_flight for a
 * same-id retry to attach to. Writing a terminal state here would make that
 * retry skip a run that is still going; the lease is what retires a row whose
 * route never came back.
 *
 * `client_closed` is deliberately NOT in that set. It means the device hung up
 * mid-run, and the row it owns is a *run* claim -- but the device is by
 * definition no longer around to be told anything, so the only thing this
 * write can still do is stop the row from pinning the session. Leaving it
 * in_flight pinned every future submission for that (device, session) pair for
 * the full 30-minute lease: a hang the device cannot see and cannot clear,
 * because from its side it simply gets a busy signal for half an hour. The
 * lease would retire the row eventually, but half an hour of "busy" is not a
 * recovery path anyone would accept, so the row is retired here instead.
 *
 * The trade is stated honestly rather than hidden: a same-id retry after a
 * detach now gets a `failed/detached` row instead of the `attached` row that
 * used to let it link onto a run still going upstream. That is right for a
 * device that vanished -- if it is really gone, nothing wants that run, and if
 * it comes back it submits a fresh id. Nothing in the current UI retries a run
 * automatically behind a recording confirm, so no existing path reaches it.
 *
 * `error_code` is a bare unconstrained `text` column on this table, so
 * `'detached'` needs no enum migration; it is only ever read by a human
 * looking at the ledger. The state is `failed`, not `completed`, because the
 * upstream run may well have gone on to succeed -- this records that *this
 * device's* delivery failed, not that the work failed.
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
      // An observe attach carries no run claim of its own -- the claim belongs
      // to whichever run route opened it -- so an observe ending never writes.
      return null;
    case 'client_closed':
      return { state: 'failed', errorCode: 'detached' };
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
        // The run is over: any half-answered multi-field sequence belongs to
        // a form upstream has already settled or cancelled.
        if (terminal !== null) abandonQuestionSequences(id);
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

/**
 * Agent run idempotency (P2): the run route claims a device-generated
 * request_id before it submits anything upstream, and writes the terminal
 * state back in a finally. A claim that finds its own expired in-flight row
 * re-claims it (lease self-healing, D6), so no scheduler is involved.
 *
 * The ledger is service_role-only; this module is the only caller.
 */

import { createHash } from 'crypto';

import { canonicalJson } from './device-control-v3-idempotency';
import { logger } from './logger';
import type { OpenCodeHistoryDetail } from './opencode-agent-detail';
import { createServiceClient } from './supabase-utils';

// Must track opencode-agent-gateway's DEFAULT_EVENT_MAX_DURATION_MS: the lease
// is that absolute cap plus slack, so no run can still be alive once its row
// is retired as stale.
const DEFAULT_EVENT_MAX_DURATION_MS = 30 * 60_000;
const LEASE_SLACK_MS = 2 * 60_000;

export function agentRunLeaseSeconds(): number {
  const raw = Number(process.env.WQN_OPENCODE_EVENT_MAX_DURATION_MS);
  const maxDurationMs =
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EVENT_MAX_DURATION_MS;
  return Math.ceil((maxDurationMs + LEASE_SLACK_MS) / 1000);
}

/**
 * Same payload, same fingerprint. `detail` is part of the identity because a
 * retry that asks for a different projection tier is not the same request.
 */
export function fingerprintAgentRunRequest(input: {
  sessionId: string;
  text: string;
  detail: OpenCodeHistoryDetail;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        session_id: input.sessionId,
        text: input.text,
        detail: input.detail,
      })
    )
    .digest('hex');
}

export type AgentRunClaimResult =
  | { kind: 'claimed' }
  | { kind: 'stale' }
  | { kind: 'attached' }
  | { kind: 'completed' }
  | { kind: 'failed'; errorCode: string | null }
  | { kind: 'conflict' }
  | { kind: 'busy' }
  | { kind: 'unavailable' };

export async function claimAgentRunRequest(input: {
  deviceId: string;
  requestId: string;
  sessionId: string;
  fingerprint: string;
}): Promise<AgentRunClaimResult> {
  const svc = createServiceClient();
  const { data, error } = await svc.rpc('claim_agent_run_request_v3', {
    p_device_id: input.deviceId,
    p_request_id: input.requestId,
    p_session_id: input.sessionId,
    p_request_fingerprint: input.fingerprint,
    p_lease_seconds: agentRunLeaseSeconds(),
  });

  const row = Array.isArray(data) ? data[0] : undefined;
  if (error || !row) {
    logger.error('Agent run claim failed', error ?? new Error('no row'), {
      component: 'AgentRunIdempotency',
      action: 'claim',
      deviceId: input.deviceId,
      requestId: input.requestId,
    });
    return { kind: 'unavailable' };
  }

  switch (row.result) {
    case 'claimed':
      return { kind: 'claimed' };
    case 'stale':
      return { kind: 'stale' };
    case 'attached':
      return { kind: 'attached' };
    case 'completed':
      return { kind: 'completed' };
    case 'failed':
      return { kind: 'failed', errorCode: row.error_code ?? null };
    case 'conflict':
      return { kind: 'conflict' };
    case 'busy':
      return { kind: 'busy' };
    default:
      logger.error(
        `Agent run claim returned an unknown result: ${String(row.result)}`,
        undefined,
        {
          component: 'AgentRunIdempotency',
          action: 'claim',
          deviceId: input.deviceId,
          requestId: input.requestId,
        }
      );
      return { kind: 'unavailable' };
  }
}

export async function completeAgentRunRequest(input: {
  deviceId: string;
  requestId: string;
  state: 'completed' | 'failed';
  errorCode: string | null;
}): Promise<void> {
  const svc = createServiceClient();
  const { error } = await svc.rpc('complete_agent_run_request_v3', {
    p_device_id: input.deviceId,
    p_request_id: input.requestId,
    p_state: input.state,
    p_error_code: input.errorCode,
  });
  if (error) {
    // Not fatal: the lease sweep retires the row eventually. A failed write
    // must not fail a run whose stream already finished.
    logger.error('Agent run complete failed', error, {
      component: 'AgentRunIdempotency',
      action: 'complete',
      deviceId: input.deviceId,
      requestId: input.requestId,
      state: input.state,
    });
  }
}

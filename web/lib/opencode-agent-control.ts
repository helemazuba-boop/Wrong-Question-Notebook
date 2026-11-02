import 'server-only';
import { createHash } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  modelSelector,
  type OpenCodeBudget,
} from '@/lib/opencode-agent-policy';
import type { OpenCodeAgentBinding } from '@/lib/opencode-agent-gateway';
import type { Json } from '@/lib/database.types';

export interface OpenCodeTask {
  id: string;
  scope: string;
  session_id: string;
  state: string;
  actual_model: string | null;
  fallback_count: number;
  request_count: number;
  primary_cooling?: boolean;
  policy: { primary: string; fallback: string; limits: OpenCodeBudget };
  deadline: string;
}

export async function openCodeControl<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown>
): Promise<T> {
  const { data, error } = await createServiceClient().rpc(
    'opencode_agent_control_v1',
    { p_action: action, p_payload: payload as Json }
  );
  if (error) throw new Error(error.message);
  return data as T;
}

export function openCodeControlScope(binding: OpenCodeAgentBinding): string {
  return createHash('sha256')
    .update(`${binding.baseUrl}\0${binding.directory}`)
    .digest('hex');
}

export async function armOpenCodeTask(
  binding: OpenCodeAgentBinding,
  identity: {
    userId: string;
    deviceId: string;
    requestId: string;
    sessionId: string;
  }
): Promise<OpenCodeTask> {
  const p = binding.modelPolicy;
  if (
    !p.enabled ||
    !p.fallback ||
    !p.limits ||
    (process.env.WQN_OPENCODE_CONTROL_SECRET?.length ?? 0) < 32
  )
    throw new Error('OpenCode control configuration is incomplete');
  return openCodeControl<OpenCodeTask>('arm', {
    ...identity,
    scope: openCodeControlScope(binding),
    policy: {
      primary: modelSelector(p.primary),
      fallback: modelSelector(p.fallback),
      limits: p.limits,
    },
  });
}

/** Capture once; delayed events must never act on a newer admission. */
export async function captureOpenCodeTask(
  binding: OpenCodeAgentBinding,
  sessionId: string
): Promise<OpenCodeTask | null> {
  if (!binding.modelPolicy.enabled) return null;
  return openCodeControl<OpenCodeTask | null>('lookup', {
    scope: openCodeControlScope(binding),
    sessionId,
  }).catch(() => null);
}

export async function finishObservedOpenCodeTask(
  task: OpenCodeTask | null,
  outcome: string,
  readOutcome: () => Promise<string>
): Promise<void> {
  if (!task || task.request_count === 0) return;
  const terminal = outcome === 'observe_ended' ? await readOutcome() : outcome;
  if (!['succeeded', 'failed', 'interrupted'].includes(terminal)) return;
  await openCodeControl('finish', {
    taskId: task.id,
    state: terminal === 'succeeded' ? 'completed' : 'failed',
  }).catch(() => undefined);
}

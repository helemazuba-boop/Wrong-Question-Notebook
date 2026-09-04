import { NextResponse } from 'next/server';

import { RATE_LIMIT_CONSTANTS } from '@/lib/constants';
import { consumeRateLimit } from '@/lib/rate-limit';

export type OpenCodeAgentRateLimitKind =
  'sessions' | 'transcribe' | 'run' | 'permission' | 'events';

const CONFIGURATIONS = {
  sessions: RATE_LIMIT_CONSTANTS.CONFIGURATIONS.esp32AgentSessions,
  transcribe: RATE_LIMIT_CONSTANTS.CONFIGURATIONS.esp32AgentTranscribe,
  run: RATE_LIMIT_CONSTANTS.CONFIGURATIONS.esp32AgentRun,
  permission: RATE_LIMIT_CONSTANTS.CONFIGURATIONS.esp32AgentEvents,
  events: RATE_LIMIT_CONSTANTS.CONFIGURATIONS.esp32AgentEvents,
} as const satisfies Record<
  OpenCodeAgentRateLimitKind,
  { windowMs: number; maxRequests: number }
>;

/**
 * Consume one slot from the per-device bucket for an agent endpoint. The
 * bucket must be keyed on the authenticated device id, which only exists
 * after authenticateEsp32Device, so this cannot be request middleware.
 * Returns a 429 response in the agent error envelope, or null to continue.
 */
export function enforceAgentRateLimit(
  deviceId: string,
  kind: OpenCodeAgentRateLimitKind
): NextResponse | null {
  const config = CONFIGURATIONS[kind];
  const result = consumeRateLimit(`esp32-agent-${kind}`, deviceId, config);
  if (result.ok) return null;
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'rate_limited',
        message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
      },
    },
    {
      status: 429,
      headers: {
        'Retry-After': result.retryAfter.toString(),
        'X-RateLimit-Limit': config.maxRequests.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': result.resetTime.toString(),
      },
    }
  );
}

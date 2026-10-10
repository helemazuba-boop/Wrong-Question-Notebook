import { NextRequest, NextResponse } from 'next/server';

import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import {
  createOpenCodeSession,
  listOpenCodeSessionsWithOutcome,
  OpenCodeGatewayError,
  resolveOpenCodeBinding,
} from '@/lib/opencode-agent-gateway';

export const runtime = 'nodejs';

function gatewayError(error: unknown): NextResponse {
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof NextResponse) return auth;
  const limited = enforceAgentRateLimit(auth.deviceId, 'sessions');
  if (limited) return limited;
  try {
    // With outcome, not plain listOpenCodeSessions: the device needs to know
    // which session is running, and reading it back per session afterwards
    // would be one detail round-trip per row.
    const sessions = await listOpenCodeSessionsWithOutcome(
      resolveOpenCodeBinding(auth.userId)
    );
    return NextResponse.json({ success: true, data: { sessions } });
  } catch (error) {
    return gatewayError(error);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof NextResponse) return auth;
  const limited = enforceAgentRateLimit(auth.deviceId, 'sessions');
  if (limited) return limited;
  try {
    const session = await createOpenCodeSession(
      resolveOpenCodeBinding(auth.userId)
    );
    return NextResponse.json({ success: true, data: { session } });
  } catch (error) {
    return gatewayError(error);
  }
}

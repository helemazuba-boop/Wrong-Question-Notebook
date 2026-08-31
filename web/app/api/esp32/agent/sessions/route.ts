import { NextRequest, NextResponse } from 'next/server';

import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import {
  listOpenCodeSessions,
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
  try {
    const sessions = await listOpenCodeSessions(
      resolveOpenCodeBinding(auth.userId)
    );
    return NextResponse.json({ success: true, data: { sessions } });
  } catch (error) {
    return gatewayError(error);
  }
}

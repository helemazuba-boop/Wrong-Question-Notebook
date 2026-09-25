import { NextRequest, NextResponse } from 'next/server';

import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import { parseOpenCodeDetail } from '@/lib/opencode-agent-detail';
import {
  assertOpenCodeSessionAccess,
  loadOpenCodeMessages,
  OpenCodeGatewayError,
  OpenCodeSessionAccessError,
  resolveOpenCodeBinding,
} from '@/lib/opencode-agent-gateway';

export const runtime = 'nodejs';
// Read-only history backfill. The device calls this when it attaches to a
// session it has not rendered yet, so it sees the turns that happened while it
// was (re)connecting.
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
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

  // `?detail=N` selects the projection tier; anything unrecognised -- including
  // an absent parameter from pre-tier firmware -- stays at full.
  const detail = parseOpenCodeDetail(req.nextUrl.searchParams.get('detail'));

  try {
    const binding = resolveOpenCodeBinding(auth.userId);
    await assertOpenCodeSessionAccess(binding, id);
    // Truncated cloud-side to the device's fixed JSON response ceiling; see
    // OPENCODE_HISTORY_JSON_BUDGET_BYTES for why this is not the device's job.
    const messages = await loadOpenCodeMessages(binding, id, detail);
    return NextResponse.json({ success: true, data: { messages } });
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
        { success: false, error: { code: error.code, message: error.message } },
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

import { NextRequest, NextResponse } from 'next/server';

import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import {
  assertOpenCodeSessionAccess,
  interruptOpenCodeSession,
  OpenCodeGatewayError,
  OpenCodeSessionAccessError,
  resolveOpenCodeBinding,
} from '@/lib/opencode-agent-gateway';
import { abandonQuestionSequences } from '@/lib/opencode-agent-question-sequence';

export const runtime = 'nodejs';
// Stop a submitted run. The device calls this from the interrupt key, which
// today only aborts a prompt that has not been submitted yet.
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof NextResponse) return auth;
  const limited = enforceAgentRateLimit(auth.deviceId, 'run');
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
    const interrupted = await interruptOpenCodeSession(binding, id);
    // Upstream cancels the pending form with the run, so the accumulated
    // answers of a multi-field sequence die with it.
    abandonQuestionSequences(id);
    return NextResponse.json({ success: true, data: { interrupted } });
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

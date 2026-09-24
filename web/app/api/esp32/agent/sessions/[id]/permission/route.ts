import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import {
  assertOpenCodeSessionAccess,
  OpenCodeGatewayError,
  OpenCodeSessionAccessError,
  replyOpenCodePermission,
  resolveOpenCodeBinding,
} from '@/lib/opencode-agent-gateway';

export const runtime = 'nodejs';

const PermissionBody = z.object({
  // The device echoes the id the cloud projected from Permission.Request, so
  // the bound matches the firmware schema rather than an arbitrary length.
  permission_id: z.string().trim().min(1).max(128),
  decision: z.enum(['once', 'reject']),
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
): Promise<NextResponse> {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof NextResponse) return auth;
  const limited = enforceAgentRateLimit(auth.deviceId, 'permission');
  if (limited) return limited;
  const { id } = await context.params;
  if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) {
    return jsonError('invalid_session', 'Invalid OpenCode session id', 422);
  }

  let parsed: z.infer<typeof PermissionBody>;
  try {
    parsed = PermissionBody.parse(await req.json());
  } catch {
    return jsonError(
      'confirmation_required',
      'An explicit on-device confirmation is required',
      422
    );
  }

  try {
    const binding = resolveOpenCodeBinding(auth.userId);
    await assertOpenCodeSessionAccess(binding, id);
    // The v2 reply path is session-scoped, so the session id travels with the
    // request instead of being inferred from a global route.
    await replyOpenCodePermission(
      binding,
      id,
      parsed.permission_id,
      parsed.decision
    );
    return NextResponse.json({ success: true, data: { replied: true } });
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

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import {
  assertOpenCodeSessionAccess,
  loadOpenCodeFormDetail,
  OpenCodeGatewayError,
  OpenCodeSessionAccessError,
  replyOpenCodeQuestion,
  resolveOpenCodeBinding,
} from '@/lib/opencode-agent-gateway';

export const runtime = 'nodejs';

const QuestionBody = z.object({
  // The id is the Form.Info id the cloud projected onto `agent.question`, so
  // the bound matches the firmware schema rather than an arbitrary length.
  question_id: z.string().trim().min(1).max(128),
  // The device chooses one of the two options it rendered; it never knows the
  // form's field ids, so it sends a bare value and the cloud assembles the
  // `answer` record upstream expects.
  answer: z.string().trim().min(1).max(256),
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

  let parsed: z.infer<typeof QuestionBody>;
  try {
    parsed = QuestionBody.parse(await req.json());
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
    // `Form.Answer` is a Record keyed by field id, and only the detail read
    // exposes the field the projected options came from. A failed detail read
    // falls back to the form id so the reply stays routable: dropping an answer
    // the user already gave is worse than one that upstream may reject.
    let fieldKey = parsed.question_id;
    try {
      const detail = await loadOpenCodeFormDetail(
        binding,
        id,
        parsed.question_id
      );
      if (detail?.fieldKey) fieldKey = detail.fieldKey;
    } catch {
      // A form that cannot be described any more is usually one that was just
      // answered or cancelled; upstream owns that verdict.
    }
    await replyOpenCodeQuestion(binding, id, parsed.question_id, {
      [fieldKey]: parsed.answer,
    });
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

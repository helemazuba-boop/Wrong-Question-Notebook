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
  type OpenCodeFormState,
} from '@/lib/opencode-agent-gateway';
import {
  beginOrGetQuestionSequence,
  completeQuestionSequence,
  recordQuestionAnswer,
  rollbackQuestionAnswer,
} from '@/lib/opencode-agent-question-sequence';

export const runtime = 'nodejs';

const QuestionBody = z.object({
  // The id the cloud projected onto `agent.question`: `{formId}#{step}` for a
  // sequence step, or a bare form id for a form that predates the sequence
  // store. The bound matches the firmware schema rather than an arbitrary
  // length.
  question_id: z.string().trim().min(1).max(128),
  // The device chooses one of the options it rendered; it never knows the
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

function replied(): NextResponse {
  return NextResponse.json({ success: true, data: { replied: true } });
}

/**
 * Split `{formId}#{step}`. A value without a numeric suffix is a legacy
 * single-shot id and is answered immediately, the way it was before the
 * sequence store existed.
 */
function splitQuestionId(questionId: string): {
  formId: string;
  step: number | null;
} {
  const index = questionId.lastIndexOf('#');
  if (index <= 0) return { formId: questionId, step: null };
  const rawStep = questionId.slice(index + 1);
  if (!/^\d+$/.test(rawStep)) return { formId: questionId, step: null };
  return { formId: questionId.slice(0, index), step: Number(rawStep) };
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
    const { formId, step } = splitQuestionId(parsed.question_id);

    let detail: OpenCodeFormState | null = null;
    try {
      detail = await loadOpenCodeFormDetail(binding, id, formId);
    } catch {
      detail = null;
    }
    if (
      detail &&
      (detail.status === 'answered' || detail.status === 'cancelled')
    ) {
      // Settled elsewhere (the OpenCode UI, or an interrupt): nothing left to
      // answer, and the accumulated steps are moot.
      completeQuestionSequence(id, formId);
      return replied();
    }
    if (!detail) {
      // A token cannot be interpreted without authoritative form metadata.
      // Never guess a field key or send an opaque device token upstream.
      completeQuestionSequence(id, formId);
      return jsonError(
        'stale_question',
        'Question must be reloaded before answering',
        409
      );
    }

    // Make sure the sequence exists (a restart between steps rebuilds it from
    // the detail read above), then record this step's answer.
    beginOrGetQuestionSequence(id, detail);
    const recorded = recordQuestionAnswer({
      sessionId: id,
      formId,
      step: step ?? 0,
      answer: parsed.answer,
    });
    if (recorded.status === 'invalid') {
      return jsonError(
        'invalid_response',
        'Question step or selected option is invalid',
        422
      );
    }
    if (recorded.status !== 'final') {
      // recorded / stale / unknown all leave the device waiting for the next
      // step; the relay re-arms it from the sequence store.
      return replied();
    }
    try {
      await replyOpenCodeQuestion(binding, id, formId, recorded.answers);
    } catch (error) {
      // Give the step back so a retry re-attempts the same submit.
      rollbackQuestionAnswer(id, formId);
      if (
        error instanceof OpenCodeGatewayError &&
        error.upstreamStatus === 409
      ) {
        // Settled elsewhere while we were collecting; treat it as answered.
        completeQuestionSequence(id, formId);
        return replied();
      }
      throw error;
    }
    completeQuestionSequence(id, formId);
    return replied();
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

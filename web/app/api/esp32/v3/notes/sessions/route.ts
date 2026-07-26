import { NextRequest, NextResponse } from 'next/server';
import {
  createV3Error,
  createV3JsonResponse,
  createV3SuccessPayload,
  readJsonBody,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import { authenticateDeviceControlV3 } from '@/lib/device-control-v3-auth';
import { createServiceClient } from '@/lib/supabase-utils';
import { logger } from '@/lib/logger';
import { noteStudyErrorResponse } from '@/lib/note-study-route';
import { createNoteStudySession } from '@/lib/note-study-service';
import {
  createNoteStudySessionRequestSchema,
  createNoteStudySessionSuccessSchema,
} from '@/lib/note-study-v1';

async function createSession(req: NextRequest) {
  const startedAt = Date.now();
  const authRequestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, authRequestId);
  if (protocolError) return protocolError;
  const auth = await authenticateDeviceControlV3(req, authRequestId);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return createV3Error(
      // The body is unparseable, but the header still carries the device's
      // request id; echoing it lets the firmware close its queue entry
      // instead of waiting out the timeout on a random id.
      authRequestId,
      400,
      'INVALID_JSON',
      false
    );
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = createNoteStudySessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  try {
    const data = await createNoteStudySession(
      createServiceClient(),
      auth.userId,
      auth.deviceId,
      parsed.data
    );
    const payload = createV3SuccessPayload(requestId, data);
    createNoteStudySessionSuccessSchema.parse(payload);
    return createV3JsonResponse(payload);
  } catch (error) {
    logger.warn('Note study session request failed', {
      component: 'NoteStudyV1',
      action: 'createSession.route',
      requestId,
      elapsedMs: Date.now() - startedAt,
    });
    return noteStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(createSession, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

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
import { noteStudyErrorResponse } from '@/lib/note-study-route';
import { loadNoteStudyCandidatePage } from '@/lib/note-study-service';
import {
  noteCandidatePageRequestSchema,
  noteCandidatePageSuccessSchema,
} from '@/lib/note-study-v1';

async function candidatePage(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
      requestIdFromUnknown(null),
      400,
      'INVALID_JSON',
      false
    );
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = noteCandidatePageRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  try {
    const { id } = await params;
    const data = await loadNoteStudyCandidatePage(
      createServiceClient(),
      auth.userId,
      auth.deviceId,
      id,
      parsed.data
    );
    const payload = createV3SuccessPayload(requestId, data);
    noteCandidatePageSuccessSchema.parse(payload);
    return createV3JsonResponse(payload);
  } catch (error) {
    return noteStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(candidatePage, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

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
import { wordStudyErrorResponse } from '@/lib/word-study-route';
import { loadWordStudyCandidatePage } from '@/lib/word-study-service';
import {
  wordCandidatePageRequestSchema,
  wordCandidatePageSuccessSchema,
} from '@/lib/word-study-v1';

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
  const parsed = wordCandidatePageRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  try {
    const { id } = await params;
    const data = await loadWordStudyCandidatePage(
      createServiceClient(),
      auth.userId,
      auth.deviceId,
      id,
      parsed.data
    );
    const payload = createV3SuccessPayload(requestId, data);
    wordCandidatePageSuccessSchema.parse(payload);
    return createV3JsonResponse(payload);
  } catch (error) {
    return wordStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(candidatePage, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

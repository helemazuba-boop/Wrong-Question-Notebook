import { NextRequest, NextResponse } from 'next/server';
import {
  createV3Error,
  createV3JsonResponse,
  createV3SuccessPayload,
  readBoundedJsonBody,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import { authenticateDeviceControlV3 } from '@/lib/device-control-v3-auth';
import { createServiceClient } from '@/lib/supabase-utils';
import { wordStudyErrorResponse } from '@/lib/word-study-route';
import {
  readWordEligibility,
  wordEligibilityRequestSchema,
} from '@/lib/word-study-eligibility';

async function eligibility(req: NextRequest) {
  const headerRequestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, headerRequestId);
  if (protocolError) return protocolError;
  const auth = await authenticateDeviceControlV3(req, headerRequestId);
  if (auth instanceof NextResponse) return auth;
  if (!auth.deviceId) {
    return createV3Error(headerRequestId, 401, 'UNAUTHORIZED', false);
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(req, 16 * 1024);
  } catch (error) {
    if (error instanceof RangeError) {
      return createV3Error(headerRequestId, 413, 'BODY_TOO_LARGE', false);
    }
    return createV3Error(headerRequestId, 400, 'INVALID_JSON', false);
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = wordEligibilityRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  try {
    const data = await readWordEligibility(
      createServiceClient(),
      auth.userId,
      auth.deviceId,
      parsed.data
    );
    const payload = createV3SuccessPayload(requestId, data);
    return createV3JsonResponse(payload);
  } catch (error) {
    return wordStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(eligibility, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

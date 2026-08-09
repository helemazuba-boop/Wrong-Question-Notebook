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
import { getEsp32RequestOrigin } from '@/lib/esp32-content';
import { createServiceClient } from '@/lib/supabase-utils';
import { loadProblemStudyManifest } from '@/lib/problem-packs';
import { problemStudyErrorResponse } from '@/lib/problem-study-route';
import {
  problemManifestRequestSchema,
  problemManifestSuccessSchema,
} from '@/lib/problem-study-v1';

async function manifest(req: NextRequest) {
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
  const parsed = problemManifestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  const cursor = Number(parsed.data.cursor);
  if (!Number.isSafeInteger(cursor)) {
    return createV3Error(requestId, 400, 'INVALID_CURSOR', false);
  }
  try {
    const data = await loadProblemStudyManifest(
      createServiceClient(),
      auth.userId,
      getEsp32RequestOrigin(req),
      cursor,
      parsed.data.limit,
      parsed.data.snapshot_id
    );
    const payload = createV3SuccessPayload(requestId, data);
    problemManifestSuccessSchema.parse(payload);
    return createV3JsonResponse(payload);
  } catch (error) {
    return problemStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(manifest, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

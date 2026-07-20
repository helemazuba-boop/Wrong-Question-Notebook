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
import { loadWordStudyManifest } from '@/lib/word-packs';
import { wordStudyErrorResponse } from '@/lib/word-study-route';
import {
  wordManifestRequestSchema,
  wordManifestSuccessSchema,
} from '@/lib/word-study-v1';

async function manifest(req: NextRequest) {
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
  const protocolError = rejectWrongV3Protocol(req, requestId);
  if (protocolError) return protocolError;

  const parsed = wordManifestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  const cursor = Number(parsed.data.cursor);
  if (!Number.isSafeInteger(cursor)) {
    return createV3Error(requestId, 400, 'INVALID_CURSOR', false);
  }
  const auth = await authenticateDeviceControlV3(req, requestId);
  if (auth instanceof NextResponse) return auth;

  try {
    const data = await loadWordStudyManifest(
      createServiceClient(),
      auth.userId,
      getEsp32RequestOrigin(req),
      cursor,
      parsed.data.limit
    );
    const payload = createV3SuccessPayload(requestId, data);
    wordManifestSuccessSchema.parse(payload);
    return createV3JsonResponse(payload);
  } catch (error) {
    return wordStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(manifest, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

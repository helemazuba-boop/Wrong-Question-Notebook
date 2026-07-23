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
import { loadNoteStudyManifest } from '@/lib/note-packs';
import { noteStudyErrorResponse } from '@/lib/note-study-route';
import {
  noteManifestRequestSchema,
  noteManifestSuccessSchema,
} from '@/lib/note-study-v1';

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
      requestIdFromUnknown(null),
      400,
      'INVALID_JSON',
      false
    );
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = noteManifestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  const cursor = Number(parsed.data.cursor);
  if (!Number.isSafeInteger(cursor)) {
    return createV3Error(requestId, 400, 'INVALID_CURSOR', false);
  }
  try {
    const data = await loadNoteStudyManifest(
      createServiceClient(),
      auth.userId,
      getEsp32RequestOrigin(req),
      cursor,
      parsed.data.limit
    );
    const payload = createV3SuccessPayload(requestId, data);
    noteManifestSuccessSchema.parse(payload);
    return createV3JsonResponse(payload);
  } catch (error) {
    return noteStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(manifest, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

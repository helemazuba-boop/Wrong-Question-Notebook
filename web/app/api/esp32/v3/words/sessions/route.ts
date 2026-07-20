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
import { wordStudyErrorResponse } from '@/lib/word-study-route';
import { createWordStudySession } from '@/lib/word-study-service';
import {
  createWordStudySessionRequestSchema,
  createWordStudySessionSuccessSchema,
} from '@/lib/word-study-v1';

async function createSession(req: NextRequest) {
  const startedAt = Date.now();
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

  const parsed = createWordStudySessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  const auth = await authenticateDeviceControlV3(req, requestId);
  if (auth instanceof NextResponse) return auth;

  try {
    const data = await createWordStudySession(
      createServiceClient(),
      auth.userId,
      auth.deviceId,
      parsed.data
    );
    const payload = createV3SuccessPayload(requestId, data);
    createWordStudySessionSuccessSchema.parse(payload);
    return createV3JsonResponse(payload);
  } catch (error) {
    logger.warn('Word study session request failed', {
      component: 'WordStudyV1',
      action: 'createSession.route',
      requestId,
      elapsedMs: Date.now() - startedAt,
      errorCode:
        error instanceof Error && 'code' in error
          ? String((error as Error & { code?: unknown }).code || '')
          : '',
    });
    return wordStudyErrorResponse(requestId, error);
  }
}

export const POST = withV3Security(createSession, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

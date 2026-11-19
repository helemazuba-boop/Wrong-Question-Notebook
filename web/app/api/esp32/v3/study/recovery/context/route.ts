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
import { hashDeviceToken, isValidDeviceToken } from '@/lib/esp32-token';
import {
  OutboxRecoveryContextError,
  readOutboxRecoveryContext,
} from '@/lib/outbox-recovery-context-service';
import {
  OUTBOX_RECOVERY_CONTEXT_MAX_REQUEST_BYTES,
  OUTBOX_RECOVERY_CONTEXT_MAX_RESPONSE_BYTES,
  OUTBOX_RECOVERY_CONTEXT_SOURCE_HEADER,
  OUTBOX_RECOVERY_CONTEXT_ACK_HEADER,
  outboxRecoveryContextRequestSchema,
} from '@/lib/outbox-recovery-context-v1';

async function lookup(req: NextRequest) {
  const headerId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, headerId);
  if (protocolError) return protocolError;
  const auth = await authenticateDeviceControlV3(req, headerId);
  if (auth instanceof NextResponse) return auth;
  const token =
    req.headers.get('authorization')?.slice('Bearer '.length).trim() ?? '';
  if (!auth.deviceId || !isValidDeviceToken(token))
    return createV3Error(headerId, 401, 'UNAUTHORIZED', false);
  const sourceMac = (
    req.headers.get(OUTBOX_RECOVERY_CONTEXT_SOURCE_HEADER) ?? ''
  ).toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(sourceMac))
    return createV3Error(headerId, 400, 'INVALID_SOURCE_MAC', false);
  let body: unknown;
  try {
    body = await readBoundedJsonBody(
      req,
      OUTBOX_RECOVERY_CONTEXT_MAX_REQUEST_BYTES
    );
  } catch (error) {
    return createV3Error(
      headerId,
      error instanceof RangeError ? 413 : 400,
      error instanceof RangeError ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
      false
    );
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = outboxRecoveryContextRequestSchema.safeParse(body);
  if (!parsed.success)
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  try {
    const data = await readOutboxRecoveryContext(
      createServiceClient(),
      auth.userId,
      auth.deviceId,
      parsed.data,
      sourceMac,
      hashDeviceToken(token),
      req.signal
    );
    const payload = createV3SuccessPayload(requestId, data);
    if (
      Buffer.byteLength(JSON.stringify(payload), 'utf8') >
      OUTBOX_RECOVERY_CONTEXT_MAX_RESPONSE_BYTES
    )
      throw new OutboxRecoveryContextError(
        'OUTBOX_RECOVERY_CONTEXT_UNAVAILABLE',
        503,
        true
      );
    const response = createV3JsonResponse(payload);
    response.headers.set(OUTBOX_RECOVERY_CONTEXT_ACK_HEADER, sourceMac);
    return response;
  } catch (error) {
    const failure =
      error instanceof OutboxRecoveryContextError
        ? error
        : new OutboxRecoveryContextError(
            'OUTBOX_RECOVERY_CONTEXT_UNAVAILABLE',
            503,
            true
          );
    return createV3Error(
      requestId,
      failure.status,
      failure.code,
      failure.retryable,
      failure.retryable ? 5000 : undefined
    );
  }
}
export const POST = withV3Security(lookup, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

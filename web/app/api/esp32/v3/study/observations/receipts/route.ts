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
import {
  OutboxReceiptError,
  readOutboxReceipts,
} from '@/lib/outbox-reconciliation-service';
import {
  OUTBOX_RECEIPTS_MAX_BYTES,
  OUTBOX_RECEIPTS_MAX_RESPONSE_BYTES,
  outboxReceiptRequestSchema,
} from '@/lib/outbox-reconciliation-v1';

async function lookup(req: NextRequest) {
  const headerId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, headerId);
  if (protocolError) return protocolError;
  const auth = await authenticateDeviceControlV3(req, headerId);
  if (auth instanceof NextResponse) return auth;
  if (!auth.deviceId)
    return createV3Error(headerId, 401, 'UNAUTHORIZED', false);
  let body: unknown;
  try {
    body = await readBoundedJsonBody(req, OUTBOX_RECEIPTS_MAX_BYTES);
  } catch (error) {
    return createV3Error(
      headerId,
      error instanceof RangeError ? 413 : 400,
      error instanceof RangeError ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
      false
    );
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = outboxReceiptRequestSchema.safeParse(body);
  if (!parsed.success)
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  try {
    const data = await readOutboxReceipts(
      createServiceClient(),
      auth.userId,
      auth.deviceId,
      parsed.data
    );
    const payload = createV3SuccessPayload(requestId, data);
    if (
      Buffer.byteLength(JSON.stringify(payload), 'utf8') >
      OUTBOX_RECEIPTS_MAX_RESPONSE_BYTES
    ) {
      throw new OutboxReceiptError('OUTBOX_RECEIPTS_UNAVAILABLE', 503, true);
    }
    return createV3JsonResponse(payload);
  } catch (error) {
    const failure =
      error instanceof OutboxReceiptError
        ? error
        : new OutboxReceiptError('OUTBOX_RECEIPTS_UNAVAILABLE', 503, true);
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

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
  OUTBOX_SOURCE_MAC_REQUEST_HEADER,
  OUTBOX_SOURCE_MAC_RESPONSE_HEADER,
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
  let sourceMac: string | undefined;
  if (req.headers.has(OUTBOX_SOURCE_MAC_REQUEST_HEADER)) {
    sourceMac = (
      req.headers.get(OUTBOX_SOURCE_MAC_REQUEST_HEADER) ?? ''
    ).toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(sourceMac))
      return createV3Error(headerId, 400, 'INVALID_SOURCE_MAC', false);
  }
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
      parsed.data,
      sourceMac
    );
    const payload = createV3SuccessPayload(requestId, data);
    if (
      Buffer.byteLength(JSON.stringify(payload), 'utf8') >
      OUTBOX_RECEIPTS_MAX_RESPONSE_BYTES
    ) {
      throw new OutboxReceiptError('OUTBOX_RECEIPTS_UNAVAILABLE', 503, true);
    }
    const response = createV3JsonResponse(payload);
    // Only the source-bound RPC can reach this acknowledgement. Never retry
    // through the legacy lookup if the new RPC is unavailable or rejects it.
    if (sourceMac !== undefined)
      response.headers.set(OUTBOX_SOURCE_MAC_RESPONSE_HEADER, sourceMac);
    return response;
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

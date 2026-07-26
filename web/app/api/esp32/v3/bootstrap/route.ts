import { NextRequest, NextResponse } from 'next/server';
import type { Json } from '@/lib/database.types';
import {
  bootstrapDataSchema,
  bootstrapRequestSchema,
  createV3Error,
  createV3JsonResponse,
  createV3SuccessPayload,
  readJsonBody,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import {
  authenticateDeviceControlV3,
  fingerprintDeviceControlRequest,
  loadDeviceControlReplay,
  storeDeviceControlResponse,
} from '@/lib/device-control-v3-auth';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';

const ENDPOINT = 'bootstrap';

async function bootstrap(req: NextRequest) {
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
  const parsed = bootstrapRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  // A verified bearer token is the credential-delivery acknowledgement. Clear
  // the repeatable claim envelope even when this request is a replay.
  const svc = createServiceClient();
  const { error: consumeError } = await svc.rpc('consume_device_claim_v3', {
    p_device_id: auth.deviceId,
  });
  if (consumeError) {
    logger.warn('Device claim cleanup deferred after bootstrap', {
      component: 'DeviceControlV3',
      action: 'consumeClaim',
      deviceId: auth.deviceId,
      requestId,
    });
  }

  const fingerprint = fingerprintDeviceControlRequest(parsed.data);
  const replay = await loadDeviceControlReplay({
    deviceId: auth.deviceId,
    requestId,
    endpoint: ENDPOINT,
    fingerprint,
  });
  if (replay.kind !== 'miss') return replay.response;

  const now = new Date().toISOString();
  const acknowledgedSyncCursor = Math.max(
    auth.syncCursor,
    parsed.data.sync_cursor
  );

  const data = bootstrapDataSchema.parse({
    device_id: auth.deviceId,
    config_revision: auth.configRevision,
    sync_cursor: acknowledgedSyncCursor,
    media_protocols: {
      ai_sse: 'v2-streaming',
      flash: 'wqn-flash-v2',
    },
  });
  const payload = createV3SuccessPayload(requestId, data);
  const stored = await storeDeviceControlResponse({
    deviceId: auth.deviceId,
    requestId,
    endpoint: ENDPOINT,
    fingerprint,
    status: 200,
    responseBody: payload as unknown as Json,
    firmwareVersion: parsed.data.firmware_version,
    capabilities: parsed.data.capabilities,
    bootId: parsed.data.boot_id,
    seenAt: now,
    lastSyncAt: null,
    acknowledgedSyncCursor,
  });
  if (stored.kind !== 'stored') return stored.response;
  return createV3JsonResponse(payload);
}

export const POST = withV3Security(bootstrap, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

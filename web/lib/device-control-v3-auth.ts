import { NextResponse } from 'next/server';
import type { Json } from './database.types';
import { createV3Error, createV3JsonResponse } from './device-control-v3';
import { hashDeviceToken, isValidDeviceToken } from './esp32-token';
import { logger } from './logger';
import { createServiceClient } from './supabase-utils';

export interface DeviceControlV3AuthContext {
  userId: string;
  deviceId: string;
  hardwareId: string;
  configRevision: number;
  syncCursor: number;
  autoSyncIntervalMinutes: number;
}

const BEARER_PREFIX = 'Bearer ';

export { fingerprintDeviceControlRequest } from './device-control-v3-idempotency';

export async function authenticateDeviceControlV3(
  req: Request,
  requestId: string
): Promise<DeviceControlV3AuthContext | NextResponse> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith(BEARER_PREFIX)) {
    return createV3Error(requestId, 401, 'UNAUTHORIZED', false);
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!isValidDeviceToken(token)) {
    return createV3Error(requestId, 401, 'UNAUTHORIZED', false);
  }

  const svc = createServiceClient();
  const { data: device, error } = await svc
    .from('esp32_devices')
    .select(
      'id, user_id, hardware_id, mac_address, config_revision, sync_cursor, auto_sync_interval_minutes'
    )
    .eq('access_token_hash', hashDeviceToken(token))
    .maybeSingle();

  if (error) {
    logger.error('Device-control v3 authentication lookup failed', error, {
      component: 'DeviceControlV3Auth',
      action: 'lookup',
      requestId,
    });
    return createV3Error(
      requestId,
      503,
      'AUTH_SERVICE_UNAVAILABLE',
      true,
      5000
    );
  }
  if (!device) {
    return createV3Error(requestId, 401, 'UNAUTHORIZED', false);
  }

  return {
    userId: device.user_id,
    deviceId: device.id,
    hardwareId: device.hardware_id || device.mac_address,
    configRevision: Number(device.config_revision),
    syncCursor: Number(device.sync_cursor),
    autoSyncIntervalMinutes: Number(device.auto_sync_interval_minutes),
  };
}

export type V3ReplayResult =
  | { kind: 'miss' }
  | { kind: 'replay'; response: NextResponse }
  | { kind: 'conflict'; response: NextResponse }
  | { kind: 'unavailable'; response: NextResponse };

export async function loadDeviceControlReplay(input: {
  deviceId: string;
  requestId: string;
  endpoint: string;
  fingerprint: string;
}): Promise<V3ReplayResult> {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('esp32_request_idempotency')
    .select(
      'endpoint, request_fingerprint, http_status, response_body, expires_at'
    )
    .eq('device_id', input.deviceId)
    .eq('request_id', input.requestId)
    .maybeSingle();

  if (error) {
    logger.error('Device-control idempotency lookup failed', error, {
      component: 'DeviceControlV3Idempotency',
      action: 'lookup',
      deviceId: input.deviceId,
      requestId: input.requestId,
    });
    return {
      kind: 'unavailable',
      response: createV3Error(
        input.requestId,
        503,
        'IDEMPOTENCY_UNAVAILABLE',
        true,
        5000
      ),
    };
  }
  if (!data || Date.parse(data.expires_at) <= Date.now())
    return { kind: 'miss' };
  if (
    data.endpoint !== input.endpoint ||
    data.request_fingerprint !== input.fingerprint
  ) {
    return {
      kind: 'conflict',
      response: createV3Error(input.requestId, 409, 'REQUEST_ID_REUSED', false),
    };
  }
  return {
    kind: 'replay',
    response: createV3JsonResponse(data.response_body, data.http_status),
  };
}

export type V3StoreResult =
  | { kind: 'stored' }
  | { kind: 'replay'; response: NextResponse }
  | { kind: 'conflict'; response: NextResponse }
  | { kind: 'unavailable'; response: NextResponse };

export async function storeDeviceControlResponse(input: {
  deviceId: string;
  requestId: string;
  endpoint: string;
  fingerprint: string;
  status: number;
  responseBody: Json;
  firmwareVersion: string;
  capabilities: string[];
  bootId: string;
  seenAt: string;
  lastSyncAt: string | null;
  acknowledgedSyncCursor: number;
}): Promise<V3StoreResult> {
  const svc = createServiceClient();
  const { error } = await svc.rpc('commit_device_control_response_v3', {
    p_device_id: input.deviceId,
    p_request_id: input.requestId,
    p_endpoint: input.endpoint,
    p_request_fingerprint: input.fingerprint,
    p_http_status: input.status,
    p_response_body: input.responseBody,
    p_firmware_version: input.firmwareVersion,
    p_capabilities: input.capabilities,
    p_boot_id: input.bootId,
    p_seen_at: input.seenAt,
    p_last_sync_at: input.lastSyncAt,
    p_ack_sync_cursor: input.acknowledgedSyncCursor,
  });

  if (!error) return { kind: 'stored' };
  if (error.code === '23505') {
    const replay = await loadDeviceControlReplay(input);
    if (replay.kind !== 'miss') return replay;
  }
  logger.error('Device-control idempotency write failed', error, {
    component: 'DeviceControlV3Idempotency',
    action: 'store',
    deviceId: input.deviceId,
    requestId: input.requestId,
  });
  return {
    kind: 'unavailable',
    response: createV3Error(
      input.requestId,
      503,
      'IDEMPOTENCY_UNAVAILABLE',
      true,
      5000
    ),
  };
}

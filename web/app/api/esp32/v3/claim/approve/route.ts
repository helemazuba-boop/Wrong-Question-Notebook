import { randomBytes, randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { Json } from '@/lib/database.types';
import {
  createV3Error,
  createV3Success,
  readJsonBody,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  sealedCredentialSchema,
  withV3Security,
} from '@/lib/device-control-v3';
import {
  hashClaimDisplayCode,
  sealDeviceCredential,
} from '@/lib/device-claim-crypto';
import { hashDeviceToken } from '@/lib/esp32-token';
import { logger } from '@/lib/logger';
import { requireUser } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';

const approvalSchema = z.strictObject({
  request_id: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  display_code: z.string().regex(/^[0-9]{8}$/),
  action: z.enum(['add', 'restore']),
  device_name: z.string().trim().min(1).max(64).optional(),
});

async function approveClaim(req: NextRequest) {
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

  const parsed = approvalSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }

  const { user } = await requireUser();
  if (!user) return createV3Error(requestId, 401, 'UNAUTHORIZED', false);

  const svc = createServiceClient();
  const { data: claim, error: claimError } = await svc
    .from('device_claims')
    .select(
      'id, status, approved_by, device_id, hardware_id, device_public_key, expires_at, sealed_credential'
    )
    .eq('display_code_hash', hashClaimDisplayCode(parsed.data.display_code))
    .in('status', ['pending', 'approved'])
    .maybeSingle();

  if (claimError) {
    logger.error('Device claim approval lookup failed', claimError, {
      component: 'DeviceClaimV3',
      action: 'approveLookup',
      requestId,
    });
    return createV3Error(
      requestId,
      503,
      'CLAIM_SERVICE_UNAVAILABLE',
      true,
      5000
    );
  }
  if (!claim) return createV3Error(requestId, 404, 'CLAIM_NOT_FOUND', false);
  if (Date.parse(claim.expires_at) <= Date.now()) {
    await svc
      .from('device_claims')
      .update({
        status: 'expired',
        display_code: null,
        display_code_hash: null,
        device_public_key: null,
        sealed_credential: null,
      })
      .eq('id', claim.id);
    return createV3Error(requestId, 410, 'CLAIM_EXPIRED', false);
  }
  if (claim.status === 'approved') {
    if (claim.approved_by !== user.id || !claim.device_id) {
      return createV3Error(requestId, 403, 'CLAIM_OWNER_MISMATCH', false);
    }
    return createV3Success(requestId, {
      status: 'approved',
      device_id: claim.device_id,
    });
  }
  if (!claim.device_public_key) {
    return createV3Error(requestId, 410, 'CLAIM_EXPIRED', false);
  }

  const { data: existingDevice, error: deviceError } = await svc
    .from('esp32_devices')
    .select('id, user_id')
    .eq('hardware_id', claim.hardware_id)
    .maybeSingle();
  if (deviceError) {
    return createV3Error(
      requestId,
      503,
      'CLAIM_SERVICE_UNAVAILABLE',
      true,
      5000
    );
  }
  if (parsed.data.action === 'restore') {
    if (!existingDevice) {
      return createV3Error(requestId, 404, 'DEVICE_NOT_FOUND', false);
    }
    if (existingDevice.user_id !== user.id) {
      return createV3Error(
        requestId,
        403,
        'DEVICE_OWNED_BY_ANOTHER_USER',
        false
      );
    }
  } else if (existingDevice) {
    return createV3Error(requestId, 409, 'DEVICE_ALREADY_EXISTS', false);
  }

  const deviceId = existingDevice?.id ?? randomUUID();
  const accessToken = randomBytes(32).toString('hex');
  let sealed;
  try {
    sealed = await sealDeviceCredential({
      claimId: claim.id,
      devicePublicKey: claim.device_public_key,
      deviceId,
      accessToken,
    });
    sealedCredentialSchema.parse(sealed);
  } catch (error) {
    logger.warn('Device claim public key rejected during approval', {
      component: 'DeviceClaimV3',
      action: 'sealCredential',
      requestId,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return createV3Error(requestId, 400, 'INVALID_DEVICE_PUBLIC_KEY', false);
  }

  const { data: approved, error: approveError } = await svc.rpc(
    'approve_device_claim_v3',
    {
      p_claim_id: claim.id,
      p_user_id: user.id,
      p_action: parsed.data.action,
      p_device_name: parsed.data.device_name || 'ESP32',
      p_device_id: deviceId,
      p_access_token_hash: hashDeviceToken(accessToken),
      p_sealed_credential: sealed as unknown as Json,
    }
  );

  if (approveError || !approved?.[0]) {
    const code = approveError?.message ?? '';
    if (code.includes('DEVICE_OWNED_BY_ANOTHER_USER')) {
      return createV3Error(
        requestId,
        403,
        'DEVICE_OWNED_BY_ANOTHER_USER',
        false
      );
    }
    if (code.includes('DEVICE_ALREADY_EXISTS')) {
      return createV3Error(requestId, 409, 'DEVICE_ALREADY_EXISTS', false);
    }
    if (code.includes('CLAIM_EXPIRED')) {
      return createV3Error(requestId, 410, 'CLAIM_EXPIRED', false);
    }
    logger.error('Device claim atomic approval failed', approveError, {
      component: 'DeviceClaimV3',
      action: 'approve',
      requestId,
    });
    return createV3Error(
      requestId,
      503,
      'CLAIM_SERVICE_UNAVAILABLE',
      true,
      5000
    );
  }

  return createV3Success(requestId, {
    status: 'approved',
    device_id: approved[0].device_id,
  });
}

export const POST = withV3Security(approveClaim, {
  rateLimitType: 'auth',
  rateLimitKey: 'user',
  enableRequestValidation: true,
});

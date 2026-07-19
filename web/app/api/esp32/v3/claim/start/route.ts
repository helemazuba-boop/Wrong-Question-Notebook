import { createHash, randomInt } from 'crypto';
import { NextRequest } from 'next/server';
import {
  claimStartRequestSchema,
  createV3Error,
  createV3Success,
  readJsonBody,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import {
  hashClaimDisplayCode,
  isValidP256PublicKey,
} from '@/lib/device-claim-crypto';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';

const CLAIM_LIFETIME_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const MAX_CODE_ATTEMPTS = 8;

function generateDisplayCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, '0');
}

async function startClaim(req: NextRequest) {
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

  const parsed = claimStartRequestSchema.safeParse(body);
  if (
    !parsed.success ||
    !isValidP256PublicKey(parsed.data?.device_public_key ?? '')
  ) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }

  const input = parsed.data;
  const hardwareId = input.hardware_id.trim().toUpperCase();
  const svc = createServiceClient();
  const { data: existing, error: existingError } = await svc
    .from('device_claims')
    .select(
      'id, display_code, expires_at, poll_interval_ms, status, device_public_key'
    )
    .eq('hardware_id', hardwareId)
    .eq('boot_id', input.boot_id)
    .eq('request_id', input.request_id)
    .maybeSingle();

  if (existingError) {
    logger.error('Device claim replay lookup failed', existingError, {
      component: 'DeviceClaimV3',
      action: 'startReplayLookup',
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
  if (existing) {
    if (
      existing.status === 'pending' &&
      existing.display_code &&
      Date.parse(existing.expires_at) > Date.now() &&
      existing.device_public_key === input.device_public_key
    ) {
      return createV3Success(requestId, {
        claim_id: existing.id,
        display_code: existing.display_code,
        expires_at_ms: Date.parse(existing.expires_at),
        poll_interval_ms: existing.poll_interval_ms,
      });
    }
    return createV3Error(requestId, 409, 'REQUEST_ID_REUSED', false);
  }

  const expiresAt = new Date(Date.now() + CLAIM_LIFETIME_MS);
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const displayCode = generateDisplayCode();
    const { data: claim, error } = await svc
      .from('device_claims')
      .insert({
        request_id: input.request_id,
        boot_id: input.boot_id,
        hardware_id: hardwareId,
        device_public_key: input.device_public_key,
        firmware_version: input.firmware_version,
        capabilities: input.capabilities,
        display_code: displayCode,
        display_code_hash: hashClaimDisplayCode(displayCode),
        expires_at: expiresAt.toISOString(),
        poll_interval_ms: POLL_INTERVAL_MS,
      })
      .select('id')
      .single();

    if (!error && claim) {
      return createV3Success(requestId, {
        claim_id: claim.id,
        display_code: displayCode,
        expires_at_ms: expiresAt.getTime(),
        poll_interval_ms: POLL_INTERVAL_MS,
      });
    }
    if (error?.code !== '23505') {
      logger.error('Device claim creation failed', error, {
        component: 'DeviceClaimV3',
        action: 'start',
        requestId,
        failureFingerprint: createHash('sha256')
          .update(`${hardwareId}:${input.boot_id}`)
          .digest('hex')
          .slice(0, 12),
      });
      return createV3Error(
        requestId,
        503,
        'CLAIM_SERVICE_UNAVAILABLE',
        true,
        5000
      );
    }
  }

  return createV3Error(requestId, 503, 'CLAIM_CODE_UNAVAILABLE', true, 5000);
}

export const POST = withV3Security(startClaim, {
  rateLimitType: 'custom',
  rateLimitKey: 'ip',
  customRateLimit: { windowMs: 10 * 60 * 1000, maxRequests: 30 },
  enableRequestValidation: false,
});

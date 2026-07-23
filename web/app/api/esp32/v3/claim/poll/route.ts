import { NextRequest } from 'next/server';
import {
  claimPollRequestSchema,
  claimPollDataSchema,
  createV3Error,
  createV3Success,
  readJsonBody,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  sealedCredentialSchema,
  withV3Security,
} from '@/lib/device-control-v3';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';

async function pollClaim(req: NextRequest) {
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

  const parsed = claimPollRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }

  const svc = createServiceClient();
  const { data: claim, error } = await svc
    .from('device_claims')
    .select('status, boot_id, expires_at, poll_interval_ms, sealed_credential')
    .eq('id', parsed.data.claim_id)
    .maybeSingle();

  if (error) {
    logger.error('Device claim poll failed', error, {
      component: 'DeviceClaimV3',
      action: 'poll',
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
  if (!claim || claim.boot_id !== parsed.data.boot_id) {
    return createV3Error(requestId, 404, 'CLAIM_NOT_FOUND', false);
  }

  if (
    Date.parse(claim.expires_at) <= Date.now() ||
    claim.status === 'expired'
  ) {
    if (claim.status !== 'expired') {
      await svc
        .from('device_claims')
        .update({
          status: 'expired',
          display_code: null,
          display_code_hash: null,
          device_public_key: null,
          sealed_credential: null,
        })
        .eq('id', parsed.data.claim_id);
    }
    return createV3Success(requestId, { status: 'expired' as const });
  }

  if (claim.status === 'pending') {
    return createV3Success(
      requestId,
      claimPollDataSchema.parse({
        status: 'pending',
        poll_interval_ms: claim.poll_interval_ms,
      })
    );
  }
  if (claim.status === 'approved') {
    const sealed = sealedCredentialSchema.safeParse(claim.sealed_credential);
    if (!sealed.success) {
      return createV3Error(
        requestId,
        503,
        'CLAIM_CREDENTIAL_UNAVAILABLE',
        true,
        5000
      );
    }
    return createV3Success(requestId, {
      status: 'approved' as const,
      sealed_credential: sealed.data,
    });
  }

  return createV3Error(requestId, 410, 'CLAIM_CONSUMED', false);
}

export const POST = withV3Security(pollClaim, {
  rateLimitType: 'esp32Poll',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

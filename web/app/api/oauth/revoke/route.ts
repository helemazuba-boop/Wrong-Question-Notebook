import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';
import { withSecurity } from '@/lib/security-middleware';
import { resolveClient } from '@/lib/oauth/clients';
import {
  hashOAuthSecret,
  isOAuthAccessToken,
  isOAuthRefreshToken,
} from '@/lib/oauth/service';

// Token revocation (RFC 7009).
//
// Always answers 200, per section 2.2: whether or not the token existed, the
// caller's desired end state (the token no longer works) has been reached, and
// answering differently would turn this endpoint into an oracle for probing
// which tokens are live.
//
// A `client_id` is required and must match the token's own client. Public
// clients cannot authenticate, so without this check one client could revoke
// another's tokens as a denial-of-service.

export const runtime = 'nodejs';

async function readParams(req: NextRequest): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const form = await req.formData().catch(() => null);
  if (form) {
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  }

  const body: unknown = await req.json().catch(() => null);
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(
      body as Record<string, unknown>
    )) {
      if (typeof value === 'string') result[key] = value;
    }
  }
  return result;
}

async function revokeByColumn(
  svc: ReturnType<typeof createServiceClient>,
  column: 'access_token_hash' | 'refresh_token_hash',
  tokenHash: string,
  clientId: string
): Promise<boolean> {
  // Conditional update: already-revoked rows are left alone so that the
  // original revocation timestamp survives as an audit record.
  const { data, error } = await svc
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq(column, tokenHash)
    .eq('client_id', clientId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    logger.error('OAuth token revocation failed', error, {
      component: 'OAuthRevoke',
      action: 'revoke',
    });
    return false;
  }
  return data !== null;
}

async function handleRevoke(req: NextRequest): Promise<NextResponse> {
  const params = await readParams(req);
  const { token, client_id: clientId, token_type_hint: hint } = params;

  const emptyOk = () => new NextResponse(null, { status: 200 });

  if (!token) return emptyOk();

  // Reject anything that cannot be one of ours before touching the database.
  const isAccessToken = isOAuthAccessToken(token);
  const isRefreshToken = isOAuthRefreshToken(token);
  if (!isAccessToken && !isRefreshToken) return emptyOk();
  if (!clientId) return emptyOk();

  if (!(await resolveClient(clientId))) return emptyOk();

  const svc = createServiceClient();
  const tokenHash = hashOAuthSecret(token);

  // Access and refresh tokens are stored on the same row, so revoking by
  // either hash kills the pair. The hint just decides which is tried first.
  const order: Array<'access_token_hash' | 'refresh_token_hash'> =
    hint === 'refresh_token' || (!isAccessToken && isRefreshToken)
      ? ['refresh_token_hash', 'access_token_hash']
      : ['access_token_hash', 'refresh_token_hash'];

  for (const column of order) {
    const revoked = await revokeByColumn(svc, column, tokenHash, clientId);
    if (revoked) {
      logger.info('OAuth token revoked', {
        component: 'OAuthRevoke',
        action: 'revoke',
        clientId,
      });
      return emptyOk();
    }
  }

  return emptyOk();
}

const REVOKE_RATE_LIMIT = {
  windowMs: 5 * 60 * 1000,
  maxRequests: 30,
};

export const POST = withSecurity(handleRevoke, {
  rateLimitType: 'custom',
  customRateLimit: REVOKE_RATE_LIMIT,
  rateLimitNamespace: 'oauth-revoke',
  rateLimitKey: 'ip',
  // Request validation has to be off for this route, and the reason is worth
  // spelling out: request-validation.ts screens URL paths against a
  // SQL-keyword blacklist that contains REVOKE, so the literal path
  // /api/oauth/revoke is flagged as an injection attempt and answered with
  // 400 before the handler ever runs. There is no injection surface on a
  // static server-controlled path, and this endpoint enforces its own strict
  // token format check plus rate limiting.
  enableRequestValidation: false,
});

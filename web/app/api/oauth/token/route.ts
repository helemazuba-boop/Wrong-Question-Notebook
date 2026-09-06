import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';
import { withSecurity } from '@/lib/security-middleware';
import { clientAllowsRedirectUri, resolveClient } from '@/lib/oauth/clients';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_OAUTH_SCOPE,
  REFRESH_TOKEN_TTL_SECONDS,
  generateOAuthAccessToken,
  generateOAuthRefreshToken,
  getMcpResourceUri,
  hashOAuthSecret,
  isAuthorizationCode,
  isOAuthRefreshToken,
  isValidCodeVerifier,
  verifyPkceS256,
} from '@/lib/oauth/service';

// Token endpoint (RFC 6749 section 3.2) for the built-in authorization server.
//
// Supports the authorization_code grant with PKCE and the refresh_token grant
// with rotation. Every token is bound to the canonical MCP resource URI
// (RFC 8707) so that /api/mcp can reject a token minted for another audience.

export const runtime = 'nodejs';

type SupabaseClient = ReturnType<typeof createServiceClient>;

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function oauthError(
  status: number,
  error: string,
  description: string
): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function serverError(): NextResponse {
  return oauthError(
    500,
    'server_error',
    'Token request could not be completed'
  );
}

/**
 * Read an OAuth token request body.
 *
 * RFC 6749 mandates application/x-www-form-urlencoded, which is what MCP
 * clients send; JSON is accepted too because some clients get this wrong.
 */
async function readParams(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get('content-type') || '';
  const result: Record<string, string> = {};

  if (contentType.includes('application/json')) {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return result;
    for (const [key, value] of Object.entries(
      body as Record<string, unknown>
    )) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  }

  const form = await req.formData().catch(() => null);
  if (!form) return result;
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

async function issueTokenPair(
  svc: SupabaseClient,
  input: { userId: string; clientId: string; scope: string; resource: string }
): Promise<IssuedTokens | null> {
  const accessToken = generateOAuthAccessToken();
  const refreshToken = generateOAuthRefreshToken();
  const now = Date.now();

  const { error } = await svc.from('oauth_tokens').insert({
    user_id: input.userId,
    client_id: input.clientId,
    access_token_hash: hashOAuthSecret(accessToken),
    refresh_token_hash: hashOAuthSecret(refreshToken),
    scope: input.scope,
    resource: input.resource,
    access_token_expires_at: new Date(
      now + ACCESS_TOKEN_TTL_SECONDS * 1000
    ).toISOString(),
    refresh_token_expires_at: new Date(
      now + REFRESH_TOKEN_TTL_SECONDS * 1000
    ).toISOString(),
  });

  if (error) {
    logger.error('OAuth token issuance failed', error, {
      component: 'OAuthToken',
      action: 'issue',
    });
    return null;
  }

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

function tokenResponse(tokens: IssuedTokens, scope: string): NextResponse {
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Revoke every live token of a (user, client) grant. */
async function revokeGrant(
  svc: SupabaseClient,
  userId: string,
  clientId: string
): Promise<void> {
  await svc
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .is('revoked_at', null);
}

/**
 * Reject a resource indicator that is not this MCP endpoint.
 *
 * A client that omits `resource` is treated as asking for the one resource
 * this server has. There is no second audience to be ambiguous about, and
 * forcing the parameter would only break older clients for no security gain.
 */
function resolveAudience(resource: string | undefined): string | null {
  const expected = getMcpResourceUri();
  if (resource === undefined || resource === expected) return expected;
  return null;
}

async function handleAuthorizationCodeGrant(
  svc: SupabaseClient,
  params: Record<string, string>
): Promise<NextResponse> {
  const { code, code_verifier: codeVerifier, client_id: clientId } = params;
  const redirectUri = params.redirect_uri;

  if (!code || !codeVerifier || !clientId || !redirectUri) {
    return oauthError(
      400,
      'invalid_request',
      'code, code_verifier, client_id and redirect_uri are required'
    );
  }

  const audience = resolveAudience(params.resource);
  if (!audience) {
    return oauthError(400, 'invalid_target', 'Unknown resource indicator');
  }

  if (!isAuthorizationCode(code)) {
    return oauthError(400, 'invalid_grant', 'Authorization code is malformed');
  }
  if (!isValidCodeVerifier(codeVerifier)) {
    return oauthError(400, 'invalid_grant', 'code_verifier is malformed');
  }

  // The authorization code is itself a 256-bit secret, so it is checked
  // before anything client-controlled is acted upon. Resolving the client
  // first would let any anonymous caller make this server fetch an arbitrary
  // CIMD URL simply by naming one here.
  const { data: row, error } = await svc
    .from('oauth_authorization_codes')
    .select(
      'id, client_id, user_id, redirect_uri, scope, resource, code_challenge, expires_at, used_at'
    )
    .eq('code_hash', hashOAuthSecret(code))
    .maybeSingle();

  if (error) {
    logger.error('Authorization code lookup failed', error, {
      component: 'OAuthToken',
      action: 'lookupCode',
    });
    return serverError();
  }
  if (!row) {
    return oauthError(400, 'invalid_grant', 'Unknown authorization code');
  }
  if (row.client_id !== clientId) {
    return oauthError(400, 'invalid_grant', 'Authorization code mismatch');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return oauthError(400, 'invalid_grant', 'Authorization code has expired');
  }
  if (row.resource !== null && row.resource !== audience) {
    return oauthError(
      400,
      'invalid_grant',
      'Authorization code audience mismatch'
    );
  }

  const client = await resolveClient(clientId);
  if (!client) {
    return oauthError(400, 'invalid_client', 'Unknown client');
  }
  // Both directions matter: the URI must be one the client registered, and
  // the one this particular code was actually issued for.
  if (!clientAllowsRedirectUri(client, redirectUri)) {
    return oauthError(
      400,
      'invalid_grant',
      'redirect_uri was not registered for this client'
    );
  }
  if (row.redirect_uri !== redirectUri) {
    return oauthError(400, 'invalid_grant', 'Authorization code mismatch');
  }

  if (!verifyPkceS256(codeVerifier, row.code_challenge)) {
    return oauthError(400, 'invalid_grant', 'PKCE verification failed');
  }

  // Consume the code and claim it in one statement. The used_at and
  // expires_at predicates make the update conditional, so two concurrent
  // redemptions cannot both see an unused code -- the loser gets zero rows
  // back and is rejected.
  const { data: consumed, error: consumeError } = await svc
    .from('oauth_authorization_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();

  if (consumeError) {
    logger.error('Authorization code consumption failed', consumeError, {
      component: 'OAuthToken',
      action: 'consumeCode',
    });
    return serverError();
  }
  if (!consumed) {
    return oauthError(400, 'invalid_grant', 'Authorization code already used');
  }

  const tokens = await issueTokenPair(svc, {
    userId: row.user_id,
    clientId: row.client_id,
    scope: row.scope || DEFAULT_OAUTH_SCOPE,
    resource: audience,
  });
  if (!tokens) return serverError();

  return tokenResponse(tokens, row.scope || DEFAULT_OAUTH_SCOPE);
}

async function handleRefreshTokenGrant(
  svc: SupabaseClient,
  params: Record<string, string>
): Promise<NextResponse> {
  const { refresh_token: refreshToken, client_id: clientId } = params;

  if (!refreshToken || !clientId) {
    return oauthError(
      400,
      'invalid_request',
      'refresh_token and client_id are required'
    );
  }

  const audience = resolveAudience(params.resource);
  if (!audience) {
    return oauthError(400, 'invalid_target', 'Unknown resource indicator');
  }

  if (!isOAuthRefreshToken(refreshToken)) {
    return oauthError(400, 'invalid_grant', 'Refresh token is malformed');
  }

  // The refresh token is a 256-bit secret, so it gates the client resolution
  // rather than the other way round -- see the same ordering note in the
  // authorization_code grant.
  const { data: row, error } = await svc
    .from('oauth_tokens')
    .select(
      'id, user_id, client_id, scope, resource, revoked_at, refresh_token_expires_at'
    )
    .eq('refresh_token_hash', hashOAuthSecret(refreshToken))
    .maybeSingle();

  if (error) {
    logger.error('Refresh token lookup failed', error, {
      component: 'OAuthToken',
      action: 'lookupRefresh',
    });
    return serverError();
  }
  if (!row || row.client_id !== clientId) {
    return oauthError(400, 'invalid_grant', 'Unknown refresh token');
  }

  const client = await resolveClient(clientId);
  if (!client) {
    return oauthError(400, 'invalid_client', 'Unknown client');
  }

  // Reuse detection (OAuth 2.1): this refresh token was already rotated away,
  // so either it leaked or a client is replaying it. Either way the whole
  // grant for this (user, client) pair is untrustworthy and gets revoked.
  if (row.revoked_at) {
    await revokeGrant(svc, row.user_id, row.client_id);
    logger.security('Refresh token reuse detected, grant revoked', 'high', {
      component: 'OAuthToken',
      action: 'refreshReuse',
      userId: row.user_id,
      tokenId: row.id,
    });
    return oauthError(400, 'invalid_grant', 'Refresh token is no longer valid');
  }

  if (
    row.refresh_token_expires_at &&
    new Date(row.refresh_token_expires_at).getTime() <= Date.now()
  ) {
    return oauthError(400, 'invalid_grant', 'Refresh token has expired');
  }
  if (row.resource !== null && row.resource !== audience) {
    return oauthError(400, 'invalid_grant', 'Refresh token audience mismatch');
  }

  // Rotation: claim the old row before minting its replacement, using the
  // same conditional-update trick as the authorization code.
  const { data: rotated, error: rotateError } = await svc
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();

  if (rotateError) {
    logger.error('Refresh token rotation failed', rotateError, {
      component: 'OAuthToken',
      action: 'rotate',
    });
    return serverError();
  }
  if (!rotated) {
    await revokeGrant(svc, row.user_id, row.client_id);
    return oauthError(400, 'invalid_grant', 'Refresh token is no longer valid');
  }

  const scope = row.scope || DEFAULT_OAUTH_SCOPE;
  const tokens = await issueTokenPair(svc, {
    userId: row.user_id,
    clientId: row.client_id,
    scope,
    resource: audience,
  });
  if (!tokens) return serverError();

  return tokenResponse(tokens, scope);
}

async function handleToken(req: NextRequest): Promise<NextResponse> {
  const params = await readParams(req);
  const grantType = params.grant_type;

  if (!grantType) {
    return oauthError(400, 'invalid_request', 'grant_type is required');
  }

  const svc = createServiceClient();

  switch (grantType) {
    case 'authorization_code':
      return handleAuthorizationCodeGrant(svc, params);
    case 'refresh_token':
      return handleRefreshTokenGrant(svc, params);
    default:
      return oauthError(
        400,
        'unsupported_grant_type',
        `Unsupported grant_type: ${grantType}`
      );
  }
}

// A dedicated bucket rather than rateLimitType: 'auth'.
//
// The shared `auth` namespace is sized for interactive login (5 attempts per
// 15 minutes). Token exchange and refresh are not login attempts: access
// tokens live an hour, so every connected MCP client refreshes at least
// hourly, and several clients behind one NAT would exhaust that budget and
// get 429s on a routine refresh. request-validation.ts already documents the
// reverse of this mistake, where one limiter drained another's bucket.
//
// The budget is generous but still bounded: it tolerates retries and a handful
// of clients per IP while making token-endpoint brute force (guessing a
// 256-bit code) pointless long before the limit matters.
const TOKEN_RATE_LIMIT = {
  windowMs: 5 * 60 * 1000,
  maxRequests: 120,
};

export const POST = withSecurity(handleToken, {
  rateLimitType: 'custom',
  customRateLimit: TOKEN_RATE_LIMIT,
  rateLimitNamespace: 'oauth-token',
  rateLimitKey: 'ip',
});

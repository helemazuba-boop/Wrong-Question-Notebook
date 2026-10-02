import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';
import { withSecurity } from '@/lib/security-middleware';
import { OAUTH_SCOPES_SUPPORTED } from '@/lib/oauth/constants';
import { generateClientId, isValidRedirectUri } from '@/lib/oauth/service';

// Dynamic Client Registration (RFC 7591).
//
// Retained for clients that predate CIMD. The MCP authorization spec now
// prefers Client ID Metadata Documents, where the client_id is simply an
// HTTPS URL and nothing has to be registered here at all. This endpoint is
// therefore unauthenticated but heavily constrained: it only ever writes an
// opaque public client with no secret, and the rate limiter bounds how much
// junk one host can create.

export const runtime = 'nodejs';

const MAX_REDIRECT_URIS = 20;
const MAX_CLIENT_NAME_LENGTH = 100;

const RegisterRequestSchema = z.object({
  client_name: z.string().trim().min(1).max(MAX_CLIENT_NAME_LENGTH),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .optional(),
  response_types: z.array(z.enum(['code'])).optional(),
});

function registrationError(description: string): NextResponse {
  return NextResponse.json(
    { error: 'invalid_client_metadata', error_description: description },
    { status: 400, headers: { 'Cache-Control': 'no-store' } }
  );
}

async function handleRegister(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return registrationError('Request body must be valid JSON');
  }

  const parsed = RegisterRequestSchema.safeParse(body);
  if (!parsed.success) {
    return registrationError(
      'client_name and redirect_uris are required and must be well formed'
    );
  }

  const { client_name: clientName, redirect_uris: redirectUris } = parsed.data;

  const rejected = redirectUris.find(uri => !isValidRedirectUri(uri));
  if (rejected !== undefined) {
    return registrationError(`Unsupported redirect_uri: ${rejected}`);
  }

  // Duplicates would let a client register the same callback twice and gain
  // no extra capability, but they would bloat the stored list on every
  // compare, so collapse them up front.
  const uniqueRedirectUris = [...new Set(redirectUris)];

  const clientId = generateClientId();
  const grantTypes = parsed.data.grant_types ?? [
    'authorization_code',
    'refresh_token',
  ];
  const responseTypes = parsed.data.response_types ?? ['code'];

  const svc = createServiceClient();
  const { error } = await svc.from('oauth_clients').insert({
    client_id: clientId,
    client_name: clientName,
    client_secret_hash: null,
    redirect_uris: uniqueRedirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    is_dynamic: true,
  });

  if (error) {
    logger.error('OAuth client registration failed', error, {
      component: 'OAuthRegister',
      action: 'insert',
    });
    return NextResponse.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Registration could not be completed',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  logger.info('OAuth client registered', {
    component: 'OAuthRegister',
    action: 'insert',
    clientId,
    redirectUriCount: uniqueRedirectUris.length,
  });

  return NextResponse.json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: uniqueRedirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      // Public client: no secret is issued, so the code exchange is protected
      // by PKCE alone.
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPES_SUPPORTED.join(' '),
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } }
  );
}

// Its own bucket, not the shared `auth` one: client registration is rare and
// should stay tightly capped, while sharing a namespace with the token
// endpoint would let registrations consume the refresh budget (or vice
// versa) -- the exact cross-contamination the namespace in rate-limit.ts
// exists to prevent.
const REGISTER_RATE_LIMIT = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 20,
};

export const POST = withSecurity(handleRegister, {
  rateLimitType: 'custom',
  customRateLimit: REGISTER_RATE_LIMIT,
  rateLimitNamespace: 'oauth-register',
  rateLimitKey: 'ip',
});

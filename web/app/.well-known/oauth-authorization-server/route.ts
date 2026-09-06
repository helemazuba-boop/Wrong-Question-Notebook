import { NextResponse } from 'next/server';
import { getAppOrigin } from '@/lib/app-origin';
import { OAUTH_SCOPES_SUPPORTED } from '@/lib/oauth/constants';

// RFC 8414 authorization server metadata.
//
// `issuer` is the origin with no query or fragment, and every advertised URL
// is absolute -- clients compare the discovery document against the issuer
// without normalising, so a stray trailing slash breaks the whole flow.
//
// Only PKCE + public clients are offered: desktop MCP clients cannot keep a
// client secret, so token_endpoint_auth_methods_supported is ["none"] and the
// code exchange is protected by the S256 challenge instead.
//
// client_id_metadata_document_supported advertises CIMD, which the MCP
// authorization spec prefers over dynamic registration: a client may use any
// HTTPS URL as its client_id and we will fetch that document to learn its
// metadata. /api/oauth/register stays available for clients that predate it.

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

export function GET() {
  const origin = getAppOrigin();

  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: OAUTH_SCOPES_SUPPORTED,
    // RFC 8707: clients must be able to name the resource they want a token
    // for, and every token we mint carries that audience.
    resource_indicators_supported: true,
    // CIMD (preferred by the MCP authorization spec) over dynamic
    // registration.
    client_id_metadata_document_supported: true,
    // RFC 9207: the authorization response carries `iss` so a client cannot
    // be tricked into redeeming a code at a mix-up attacker's token endpoint.
    authorization_response_iss_parameter_supported: true,
  });
}

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  API_TOKEN_PREFIX,
  hashApiToken,
  isValidApiToken,
} from '@/lib/api-token';
import { getAppOrigin } from '@/lib/app-origin';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  getMcpResourceUri,
  hasRequiredMcpScope,
  hashOAuthSecret,
  isOAuthAccessToken,
} from '@/lib/oauth/service';
import {
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_SCOPES_SUPPORTED,
} from '@/lib/oauth/constants';

// Bearer authentication for the public MCP endpoint. Mirrors
// esp32-device-auth.ts: extract the token, hash it, look the digest up, never
// compare plaintext. Revoked tokens fail closed.
//
// Two credential kinds are accepted and dispatched on by prefix:
//   - wqn_mcp_*  personal access token the user generated in the web UI
//                (user_api_tokens, long lived, revoked only by hand)
//   - wqn_oa_*   OAuth 2.1 access token minted by this app's own
//                authorization server (oauth_tokens, 1 hour, rotated)
// Both resolve to the same context, so no MCP tool sees a difference.

export interface ApiTokenAuthContext {
  userId: string;
  tokenId: string;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Build the `WWW-Authenticate` challenge for the MCP endpoint.
 *
 * This header is what lets a spec-compliant MCP client bootstrap itself: it
 * fetches the referenced RFC 9728 document, finds the authorization server,
 * and starts the OAuth 2.1 flow without the user hand-copying a token.
 *
 * `scope` is included because the MCP spec asks servers to advertise the
 * scope they need here, so the client can request exactly that instead of
 * discovering it by trial and error.
 */
function bearerChallenge(extraParams: string[] = []): string {
  const metadataUrl = `${getAppOrigin()}${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}`;
  const params = [
    `resource_metadata="${metadataUrl}"`,
    `scope="${OAUTH_SCOPES_SUPPORTED.join(' ')}"`,
    ...extraParams,
  ];
  return `Bearer ${params.join(', ')}`;
}

export function createApiTokenUnauthorizedResponse(
  message = 'Unauthorized'
): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message },
    },
    { status: 401, headers: { 'WWW-Authenticate': bearerChallenge() } }
  );
}

/**
 * 403 for a credential that authenticated but does not carry the required
 * scope (RFC 6750 section 3.1).
 */
export function createApiTokenInsufficientScopeResponse(
  message = 'Insufficient scope'
): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32003, message },
    },
    {
      status: 403,
      headers: {
        'WWW-Authenticate': bearerChallenge(['error="insufficient_scope"']),
      },
    }
  );
}

function tokenLookupFailedResponse(): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Failed to authenticate token' },
    },
    { status: 500 }
  );
}

/** Resolve a personal access token (wqn_mcp_*). */
async function authenticateLegacyPatToken(
  svc: ReturnType<typeof createServiceClient>,
  token: string
): Promise<ApiTokenAuthContext | NextResponse> {
  const { data: row, error } = await svc
    .from('user_api_tokens')
    .select('id, user_id')
    .eq('token_hash', hashApiToken(token))
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    logger.error('MCP token auth lookup failed', error, {
      component: 'ApiTokenAuth',
      action: 'lookup',
    });
    return tokenLookupFailedResponse();
  }
  if (!row) {
    return createApiTokenUnauthorizedResponse('Invalid access token');
  }

  // Best-effort usage timestamp; auth success never blocks on it.
  void svc
    .from('user_api_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(({ error: touchError }) => {
      if (touchError) {
        logger.warn('MCP token last_used update failed', {
          component: 'ApiTokenAuth',
          action: 'touch',
          tokenId: row.id,
        });
      }
    });

  return { userId: row.user_id, tokenId: row.id };
}

/** Resolve an OAuth 2.1 access token (wqn_oa_*). */
async function authenticateOAuthToken(
  svc: ReturnType<typeof createServiceClient>,
  token: string
): Promise<ApiTokenAuthContext | NextResponse> {
  const { data: row, error } = await svc
    .from('oauth_tokens')
    .select('id, user_id, scope, resource, access_token_expires_at, revoked_at')
    .eq('access_token_hash', hashOAuthSecret(token))
    .maybeSingle();

  if (error) {
    logger.error('MCP OAuth token lookup failed', error, {
      component: 'ApiTokenAuth',
      action: 'lookupOAuth',
    });
    return tokenLookupFailedResponse();
  }
  if (!row) {
    return createApiTokenUnauthorizedResponse('Invalid access token');
  }

  if (row.revoked_at) {
    return createApiTokenUnauthorizedResponse('Access token has been revoked');
  }
  if (new Date(row.access_token_expires_at).getTime() <= Date.now()) {
    return createApiTokenUnauthorizedResponse('Access token has expired');
  }

  // Audience check (RFC 8707): a token minted for a different resource must
  // not be accepted here. A NULL resource predates the column and is treated
  // as a mismatch so a missing value can only lock a token out.
  if (row.resource !== getMcpResourceUri()) {
    logger.security('OAuth token rejected for audience mismatch', 'medium', {
      component: 'ApiTokenAuth',
      action: 'audienceMismatch',
      tokenId: row.id,
    });
    return createApiTokenUnauthorizedResponse('Invalid access token audience');
  }

  if (!hasRequiredMcpScope(row.scope)) {
    return createApiTokenInsufficientScopeResponse();
  }

  void svc
    .from('oauth_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(({ error: touchError }) => {
      if (touchError) {
        logger.warn('MCP OAuth token last_used update failed', {
          component: 'ApiTokenAuth',
          action: 'touchOAuth',
          tokenId: row.id,
        });
      }
    });

  return { userId: row.user_id, tokenId: row.id };
}

export async function authenticateMcpRequest(
  req: Request
): Promise<ApiTokenAuthContext | NextResponse> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return createApiTokenUnauthorizedResponse(
      'Missing or invalid Authorization header'
    );
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    return createApiTokenUnauthorizedResponse('Invalid access token');
  }

  const svc = createServiceClient();

  if (token.startsWith(API_TOKEN_PREFIX)) {
    if (!isValidApiToken(token)) {
      return createApiTokenUnauthorizedResponse('Invalid access token');
    }
    return authenticateLegacyPatToken(svc, token);
  }

  if (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    if (!isOAuthAccessToken(token)) {
      return createApiTokenUnauthorizedResponse('Invalid access token');
    }
    return authenticateOAuthToken(svc, token);
  }

  return createApiTokenUnauthorizedResponse('Invalid access token');
}

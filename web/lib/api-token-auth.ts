import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';
import { hashApiToken, isValidApiToken } from '@/lib/api-token';

// Bearer authentication for the public MCP endpoint. Mirrors
// esp32-device-auth.ts: extract the token, hash it, look the digest up, never
// compare plaintext. Revoked tokens fail closed.

export interface ApiTokenAuthContext {
  userId: string;
  tokenId: string;
}

const BEARER_PREFIX = 'Bearer ';

export function createApiTokenUnauthorizedResponse(
  message = 'Unauthorized'
): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message },
    },
    { status: 401 }
  );
}

export async function authenticateApiToken(
  req: Request
): Promise<ApiTokenAuthContext | NextResponse> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return createApiTokenUnauthorizedResponse(
      'Missing or invalid Authorization header'
    );
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!isValidApiToken(token)) {
    return createApiTokenUnauthorizedResponse('Invalid access token');
  }

  const svc = createServiceClient();
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
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Failed to authenticate token' },
      },
      { status: 500 }
    );
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

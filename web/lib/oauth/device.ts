import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateOAuthAccessToken,
  generateOAuthRefreshToken,
  getMcpResourceUri,
  hashOAuthSecret,
} from './service';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateDeviceCodes() {
  const code = Array.from(randomBytes(8), b => USER_CODE_ALPHABET[b % 32]).join(
    ''
  );
  return {
    deviceCode: `wqn_dc_${randomBytes(32).toString('hex')}`,
    userCode: `${code.slice(0, 4)}-${code.slice(4)}`,
  };
}

export function normalizeUserCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null;
}

export function deviceOAuthResponse(
  body: Record<string, unknown>,
  status = 200
) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

export async function exchangeDeviceCode(params: Record<string, string>) {
  if (
    !/^wqn_dc_[0-9a-f]{64}$/.test(params.device_code ?? '') ||
    !params.client_id
  ) {
    return deviceOAuthResponse({ error: 'invalid_request' }, 400);
  }
  const resource = getMcpResourceUri();
  if (params.resource !== resource) {
    return deviceOAuthResponse({ error: 'invalid_target' }, 400);
  }
  const accessToken = generateOAuthAccessToken();
  const refreshToken = generateOAuthRefreshToken();
  const { data, error } = await createServiceClient().rpc(
    'oauth_poll_device_authorization',
    {
      p_device_code_hash: hashOAuthSecret(params.device_code),
      p_client_id: params.client_id,
      p_resource: resource,
      p_access_token_hash: hashOAuthSecret(accessToken),
      p_refresh_token_hash: hashOAuthSecret(refreshToken),
      p_access_ttl_seconds: ACCESS_TOKEN_TTL_SECONDS,
      p_refresh_ttl_seconds: REFRESH_TOKEN_TTL_SECONDS,
    }
  );
  // Do not log RPC arguments: they contain credential hashes.
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    return deviceOAuthResponse({ error: 'server_error' }, 500);
  }
  if (typeof data.error === 'string') {
    return deviceOAuthResponse({ error: data.error }, 400);
  }
  if (data.scope !== 'mcp:all' || typeof data.user_id !== 'string') {
    return deviceOAuthResponse({ error: 'server_error' }, 500);
  }
  return deviceOAuthResponse({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: data.scope,
    user_id: data.user_id,
  });
}

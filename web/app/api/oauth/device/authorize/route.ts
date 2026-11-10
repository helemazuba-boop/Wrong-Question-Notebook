import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getAppOrigin } from '@/lib/app-origin';
import { createServiceClient } from '@/lib/supabase-utils';
import { withSecurity } from '@/lib/security-middleware';
import { getMcpResourceUri, hashOAuthSecret } from '@/lib/oauth/service';
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_GRANT_TYPE,
  DEVICE_POLL_INTERVAL_SECONDS,
  deviceOAuthResponse,
  generateDeviceCodes,
  normalizeUserCode,
} from '@/lib/oauth/device';

export const runtime = 'nodejs';
const schema = z.object({
  client_id: z.string().min(1).max(200),
  scope: z.literal('mcp:all').default('mcp:all'),
  resource: z.string().max(2048),
});

async function handleAuthorize(req: NextRequest) {
  let body: unknown;
  try {
    body = req.headers.get('content-type')?.includes('application/json')
      ? await req.json()
      : Object.fromEntries(await req.formData());
  } catch {
    return deviceOAuthResponse({ error: 'invalid_request' }, 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return deviceOAuthResponse(
      {
        error: parsed.error.issues.some(issue => issue.path[0] === 'scope')
          ? 'invalid_scope'
          : 'invalid_request',
      },
      400
    );
  if (parsed.data.resource !== getMcpResourceUri()) {
    return deviceOAuthResponse({ error: 'invalid_target' }, 400);
  }
  const svc = createServiceClient();
  const { data: client, error: clientError } = await svc
    .from('oauth_clients')
    .select('client_id, grant_types')
    .eq('client_id', parsed.data.client_id)
    .maybeSingle();
  if (clientError) return deviceOAuthResponse({ error: 'server_error' }, 500);
  if (!client || !client.grant_types.includes(DEVICE_GRANT_TYPE)) {
    return deviceOAuthResponse({ error: 'unauthorized_client' }, 400);
  }
  const { deviceCode, userCode } = generateDeviceCodes();
  const { error } = await svc.from('oauth_device_authorizations').insert({
    client_id: client.client_id,
    device_code_hash: hashOAuthSecret(deviceCode),
    user_code_hash: hashOAuthSecret(normalizeUserCode(userCode)!),
    scope: parsed.data.scope,
    resource: parsed.data.resource,
    expires_at: new Date(
      Date.now() + DEVICE_CODE_TTL_SECONDS * 1000
    ).toISOString(),
  });
  if (error) return deviceOAuthResponse({ error: 'server_error' }, 500);
  const verificationUri = `${getAppOrigin()}/oauth/device`;
  return deviceOAuthResponse({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: userCode })}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  });
}

export const POST = withSecurity(handleAuthorize, {
  rateLimitType: 'custom',
  customRateLimit: { windowMs: 60 * 60 * 1000, maxRequests: 20 },
  rateLimitNamespace: 'oauth-device-start',
  rateLimitKey: 'ip',
});

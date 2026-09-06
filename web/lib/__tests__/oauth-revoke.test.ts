import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveClient, mockFrom, mockAuthenticate } = vi.hoisted(() => ({
  mockResolveClient: vi.fn(),
  mockFrom: vi.fn(),
  mockAuthenticate: vi.fn(),
}));

vi.mock('@/lib/oauth/clients', () => ({
  resolveClient: mockResolveClient,
  clientAllowsRedirectUri: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom }),
}));
vi.mock('@/lib/api-token-auth', () => ({
  authenticateMcpRequest: mockAuthenticate,
}));

const { POST } = await import('@/app/api/oauth/revoke/route');
const { _resetRateLimitStore } = await import('@/lib/rate-limit');
const { installFakeSupabase } = await import('@/lib/test/fake-supabase');
import type { FakeQueryCall, FakeQueryHandler } from '@/lib/test/fake-supabase';

const ORIGIN = 'https://wqn.example.test';
const CLIENT_ID = 'wqn_client_' + 'a'.repeat(32);
const ACCESS_TOKEN = `wqn_oa_${'a'.repeat(64)}`;
const REFRESH_TOKEN = `wqn_rt_${'b'.repeat(64)}`;

function revokeRequest(params: Record<string, string>): NextRequest {
  return new NextRequest(`${ORIGIN}/api/oauth/revoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'vitest-oauth',
      'x-forwarded-for': '127.0.0.1',
    },
    body: new URLSearchParams(params).toString(),
  });
}

function install(handler: FakeQueryHandler): FakeQueryCall[] {
  return installFakeSupabase(mockFrom as never, handler);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitStore();
  process.env.SITE_URL = ORIGIN;
  mockResolveClient.mockResolvedValue({
    clientId: CLIENT_ID,
    clientName: 'Test Client',
    redirectUris: ['https://client.example.test/callback'],
    source: 'database',
  });
});

describe('token revocation (RFC 7009)', () => {
  it('revokes an access token scoped to its own client', async () => {
    const calls = install(call =>
      call.op === 'update'
        ? { data: { id: 'row-1' }, error: null }
        : { data: null, error: null }
    );

    const res = await POST(
      revokeRequest({
        token: ACCESS_TOKEN,
        token_type_hint: 'access_token',
        client_id: CLIENT_ID,
      })
    );

    expect(res.status).toBe(200);
    const revoke = calls.find(c => c.op === 'update');
    expect(revoke?.table).toBe('oauth_tokens');
    // Scoping to the client stops one client revoking another's tokens.
    expect(revoke?.filters).toContainEqual(['eq', 'client_id', CLIENT_ID]);
    // Conditional: an already-revoked row keeps its original timestamp.
    expect(revoke?.filters).toContainEqual(['is', 'revoked_at', null]);
  });

  it('still answers 200 when the token does not exist', async () => {
    install(() => ({ data: null, error: null }));

    const res = await POST(
      revokeRequest({ token: ACCESS_TOKEN, client_id: CLIENT_ID })
    );

    // RFC 7009 section 2.2: the endpoint must not become an oracle for
    // probing which tokens are live.
    expect(res.status).toBe(200);
  });

  it('still answers 200 for a malformed token', async () => {
    install(() => ({ data: null, error: null }));

    const res = await POST(
      revokeRequest({ token: 'not-a-token', client_id: CLIENT_ID })
    );

    expect(res.status).toBe(200);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('refuses to touch the database when the client is unknown', async () => {
    mockResolveClient.mockResolvedValue(null);
    install(() => ({ data: null, error: null }));

    const res = await POST(
      revokeRequest({ token: ACCESS_TOKEN, client_id: 'wqn_client_unknown' })
    );

    expect(res.status).toBe(200);
    const updates = mockFrom.mock.calls.length;
    expect(updates).toBe(0);
  });

  it('tries the refresh column first when hinted', async () => {
    const calls = install(() => ({ data: null, error: null }));

    await POST(
      revokeRequest({
        token: REFRESH_TOKEN,
        token_type_hint: 'refresh_token',
        client_id: CLIENT_ID,
      })
    );

    expect(calls[0]?.filters).toContainEqual([
      'eq',
      'refresh_token_hash',
      expect.any(String),
    ]);
  });

  it('requires a client_id', async () => {
    install(() => ({ data: null, error: null }));

    const res = await POST(revokeRequest({ token: ACCESS_TOKEN }));

    expect(res.status).toBe(200);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

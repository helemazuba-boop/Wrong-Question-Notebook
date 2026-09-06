import { createHash, randomBytes } from 'crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveClient, mockAllowsRedirect, mockFrom } = vi.hoisted(() => ({
  mockResolveClient: vi.fn(),
  mockAllowsRedirect: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('@/lib/oauth/clients', () => ({
  resolveClient: mockResolveClient,
  clientAllowsRedirectUri: mockAllowsRedirect,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom }),
}));

const { POST } = await import('@/app/api/oauth/token/route');
const { _resetRateLimitStore } = await import('@/lib/rate-limit');
const { installFakeSupabase } = await import('@/lib/test/fake-supabase');
import type { FakeQueryCall, FakeQueryHandler } from '@/lib/test/fake-supabase';

const ORIGIN = 'https://wqn.example.test';
const RESOURCE = `${ORIGIN}/api/mcp`;
const CLIENT_ID = 'wqn_client_' + 'a'.repeat(32);
const REDIRECT_URI = 'https://client.example.test/callback';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Row = Record<string, unknown>;
type Call = FakeQueryCall;

function installSupabase(handler: FakeQueryHandler): Call[] {
  return installFakeSupabase(mockFrom as never, handler);
}

function tokenRequest(params: Record<string, string>): NextRequest {
  return new NextRequest(`${ORIGIN}/api/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'vitest-oauth',
      'x-forwarded-for': '127.0.0.1',
    },
    body: new URLSearchParams(params).toString(),
  });
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function codeRow(overrides: Row = {}): Row {
  const verifier = randomBytes(32).toString('base64url');
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    client_id: CLIENT_ID,
    user_id: USER_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'mcp:all',
    resource: RESOURCE,
    code_challenge: challengeFor(verifier),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    used_at: null,
    _verifier: verifier,
    ...overrides,
  };
}

function tokenRow(overrides: Row = {}): Row {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    user_id: USER_ID,
    client_id: CLIENT_ID,
    scope: 'mcp:all',
    resource: RESOURCE,
    revoked_at: null,
    refresh_token_expires_at: new Date(
      Date.now() + 86_400_000
    ).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitStore();
  process.env.SITE_URL = ORIGIN;
  mockAllowsRedirect.mockReturnValue(true);
  mockResolveClient.mockResolvedValue({
    clientId: CLIENT_ID,
    clientName: 'Test Client',
    redirectUris: [REDIRECT_URI],
    source: 'database',
  });
});

describe('authorization_code grant', () => {
  it('exchanges a valid code for a token pair', async () => {
    const row = codeRow();
    const calls = installSupabase(call => {
      if (call.table === 'oauth_authorization_codes' && call.op === 'select') {
        return { data: row, error: null };
      }
      if (call.table === 'oauth_authorization_codes' && call.op === 'update') {
        // Conditional update succeeded: one row claimed.
        return { data: { id: row.id }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await POST(
      tokenRequest({
        grant_type: 'authorization_code',
        code: `wqn_code_${'a'.repeat(64)}`,
        code_verifier: row._verifier as string,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^wqn_oa_[0-9a-f]{64}$/);
    expect(body.refresh_token).toMatch(/^wqn_rt_[0-9a-f]{64}$/);
    expect(body.scope).toBe('mcp:all');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const insert = calls.find(c => c.op === 'insert');
    expect(insert?.table).toBe('oauth_tokens');
    expect(insert?.payload?.resource).toBe(RESOURCE);
  });

  it('consumes the code conditionally so a replay is rejected', async () => {
    const row = codeRow();
    let updateCalls = 0;
    installSupabase(call => {
      if (call.table === 'oauth_authorization_codes' && call.op === 'select') {
        return { data: row, error: null };
      }
      if (call.table === 'oauth_authorization_codes' && call.op === 'update') {
        updateCalls += 1;
        // Second call loses the race: zero rows matched.
        return updateCalls === 1
          ? { data: { id: row.id }, error: null }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    });

    const params = {
      grant_type: 'authorization_code',
      code: `wqn_code_${'b'.repeat(64)}`,
      code_verifier: row._verifier as string,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    };

    expect((await POST(tokenRequest(params))).status).toBe(200);
    const replay = await POST(tokenRequest(params));

    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  it('rejects a wrong code_verifier', async () => {
    const row = codeRow();
    const calls = installSupabase(call =>
      call.table === 'oauth_authorization_codes' && call.op === 'select'
        ? { data: row, error: null }
        : { data: null, error: null }
    );

    const res = await POST(
      tokenRequest({
        grant_type: 'authorization_code',
        code: `wqn_code_${'c'.repeat(64)}`,
        code_verifier: randomBytes(32).toString('base64url'),
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    // No token and no consumption when PKCE fails.
    expect(calls.some(c => c.op === 'insert')).toBe(false);
    expect(calls.some(c => c.op === 'update')).toBe(false);
  });

  it('rejects an expired code', async () => {
    installSupabase(call =>
      call.table === 'oauth_authorization_codes' && call.op === 'select'
        ? {
            data: codeRow({
              expires_at: new Date(Date.now() - 1000).toISOString(),
            }),
            error: null,
          }
        : { data: null, error: null }
    );

    const res = await POST(
      tokenRequest({
        grant_type: 'authorization_code',
        code: `wqn_code_${'d'.repeat(64)}`,
        code_verifier: randomBytes(32).toString('base64url'),
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      })
    );

    expect((await res.json()).error_description).toMatch(/expired/);
  });

  it('rejects a redirect_uri the client never registered', async () => {
    installSupabase(call =>
      call.table === 'oauth_authorization_codes' && call.op === 'select'
        ? { data: codeRow(), error: null }
        : { data: null, error: null }
    );
    mockAllowsRedirect.mockReturnValue(false);

    const res = await POST(
      tokenRequest({
        grant_type: 'authorization_code',
        code: `wqn_code_${'e'.repeat(64)}`,
        code_verifier: randomBytes(32).toString('base64url'),
        client_id: CLIENT_ID,
        redirect_uri: 'https://evil.example.test/callback',
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('does not resolve the client when the code is unknown', async () => {
    // Guards the ordering fix: the code is a secret, so it must gate any
    // client resolution that could trigger an outbound CIMD fetch.
    installSupabase(() => ({ data: null, error: null }));

    const res = await POST(
      tokenRequest({
        grant_type: 'authorization_code',
        code: `wqn_code_${'f'.repeat(64)}`,
        code_verifier: randomBytes(32).toString('base64url'),
        client_id: 'https://attacker.example.test/metadata.json',
        redirect_uri: REDIRECT_URI,
      })
    );

    expect(res.status).toBe(400);
    expect(mockResolveClient).not.toHaveBeenCalled();
  });

  it('rejects a resource indicator that is not this MCP endpoint', async () => {
    const res = await POST(
      tokenRequest({
        grant_type: 'authorization_code',
        code: `wqn_code_${'1'.repeat(64)}`,
        code_verifier: randomBytes(32).toString('base64url'),
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: 'https://elsewhere.example.test/api/other',
      })
    );

    expect((await res.json()).error).toBe('invalid_target');
  });
});

describe('refresh_token grant', () => {
  it('rotates the refresh token', async () => {
    const row = tokenRow();
    const calls = installSupabase(call => {
      if (call.table === 'oauth_tokens' && call.op === 'select') {
        return { data: row, error: null };
      }
      if (call.table === 'oauth_tokens' && call.op === 'update') {
        return { data: { id: row.id }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await POST(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: `wqn_rt_${'a'.repeat(64)}`,
        client_id: CLIENT_ID,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^wqn_oa_/);
    expect(body.refresh_token).toMatch(/^wqn_rt_/);

    // The old row is revoked before the replacement is minted.
    const revoke = calls.find(
      c => c.op === 'update' && c.payload?.revoked_at !== undefined
    );
    expect(revoke?.filters).toContainEqual(['is', 'revoked_at', null]);
    expect(calls.some(c => c.op === 'insert')).toBe(true);
  });

  it('revokes the whole grant when a rotated token is replayed', async () => {
    const row = tokenRow({ revoked_at: new Date().toISOString() });
    const calls = installSupabase(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? { data: row, error: null }
        : { data: null, error: null }
    );

    const res = await POST(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: `wqn_rt_${'b'.repeat(64)}`,
        client_id: CLIENT_ID,
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');

    // Cascading revocation scoped to the (user, client) pair.
    const cascade = calls.find(
      c => c.op === 'update' && c.filters.some(f => f[1] === 'client_id')
    );
    expect(cascade?.filters).toContainEqual(['eq', 'user_id', USER_ID]);
    expect(cascade?.filters).toContainEqual(['eq', 'client_id', CLIENT_ID]);
  });

  it('rejects an expired refresh token', async () => {
    installSupabase(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? {
            data: tokenRow({
              refresh_token_expires_at: new Date(
                Date.now() - 1000
              ).toISOString(),
            }),
            error: null,
          }
        : { data: null, error: null }
    );

    const res = await POST(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: `wqn_rt_${'c'.repeat(64)}`,
        client_id: CLIENT_ID,
      })
    );

    expect((await res.json()).error_description).toMatch(/expired/);
  });

  it('rejects a refresh token presented with the wrong client_id', async () => {
    installSupabase(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? { data: tokenRow({ client_id: 'wqn_client_other' }), error: null }
        : { data: null, error: null }
    );

    const res = await POST(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: `wqn_rt_${'d'.repeat(64)}`,
        client_id: CLIENT_ID,
      })
    );

    expect((await res.json()).error).toBe('invalid_grant');
    expect(mockResolveClient).not.toHaveBeenCalled();
  });
});

describe('request handling', () => {
  it('rejects an unsupported grant type', async () => {
    installSupabase(() => ({ data: null, error: null }));

    const res = await POST(
      tokenRequest({ grant_type: 'client_credentials', client_id: CLIENT_ID })
    );

    expect((await res.json()).error).toBe('unsupported_grant_type');
  });

  it('requires a grant_type', async () => {
    installSupabase(() => ({ data: null, error: null }));

    const res = await POST(tokenRequest({ client_id: CLIENT_ID }));

    expect((await res.json()).error).toBe('invalid_request');
  });

  it('accepts a JSON body as well as form encoding', async () => {
    const row = codeRow();
    installSupabase(call =>
      call.table === 'oauth_authorization_codes' && call.op === 'select'
        ? { data: row, error: null }
        : { data: { id: row.id }, error: null }
    );

    const res = await POST(
      new NextRequest(`${ORIGIN}/api/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'vitest-oauth',
          'x-forwarded-for': '127.0.0.1',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: `wqn_code_${'9'.repeat(64)}`,
          code_verifier: row._verifier,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
        }),
      })
    );

    expect(res.status).toBe(200);
  });
});

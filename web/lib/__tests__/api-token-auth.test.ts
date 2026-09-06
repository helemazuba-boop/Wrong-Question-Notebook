import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom }),
}));

const {
  authenticateMcpRequest,
  createApiTokenUnauthorizedResponse,
  createApiTokenInsufficientScopeResponse,
} = await import('@/lib/api-token-auth');
const { installFakeSupabase } = await import('@/lib/test/fake-supabase');
import type { FakeQueryCall, FakeQueryHandler } from '@/lib/test/fake-supabase';

const ORIGIN = 'https://wqn.example.test';
const RESOURCE = `${ORIGIN}/api/mcp`;
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAT = `wqn_mcp_${'a'.repeat(64)}`;
const OAUTH_ACCESS = `wqn_oa_${'b'.repeat(64)}`;

function mcpRequest(token: string): NextRequest {
  return new NextRequest(`${ORIGIN}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

function install(handler: FakeQueryHandler): FakeQueryCall[] {
  return installFakeSupabase(mockFrom as never, handler);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = ORIGIN;
});

describe('personal access tokens (wqn_mcp_)', () => {
  it('authenticates against user_api_tokens', async () => {
    const calls = install(call =>
      call.table === 'user_api_tokens' && call.op === 'select'
        ? { data: { id: 'pat-row', user_id: USER_ID }, error: null }
        : { data: null, error: null }
    );

    const result = await authenticateMcpRequest(mcpRequest(PAT));

    expect(result).toEqual({ userId: USER_ID, tokenId: 'pat-row' });
    expect(calls[0].table).toBe('user_api_tokens');
    expect(calls[0].filters).toContainEqual(['is', 'revoked_at', null]);
  });

  it('never consults the OAuth table', async () => {
    const calls = install(call =>
      call.table === 'user_api_tokens' && call.op === 'select'
        ? { data: { id: 'pat-row', user_id: USER_ID }, error: null }
        : { data: null, error: null }
    );

    await authenticateMcpRequest(mcpRequest(PAT));

    expect(calls.every(c => c.table === 'user_api_tokens')).toBe(true);
  });
});

describe('OAuth access tokens (wqn_oa_)', () => {
  function oauthRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'oauth-row',
      user_id: USER_ID,
      scope: 'mcp:all',
      resource: RESOURCE,
      revoked_at: null,
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    };
  }

  it('authenticates against oauth_tokens', async () => {
    const calls = install(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? { data: oauthRow(), error: null }
        : { data: null, error: null }
    );

    const result = await authenticateMcpRequest(mcpRequest(OAUTH_ACCESS));

    expect(result).toEqual({ userId: USER_ID, tokenId: 'oauth-row' });
    expect(calls[0].table).toBe('oauth_tokens');
  });

  it('rejects a revoked token', async () => {
    install(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? {
            data: oauthRow({ revoked_at: new Date().toISOString() }),
            error: null,
          }
        : { data: null, error: null }
    );

    const result = await authenticateMcpRequest(mcpRequest(OAUTH_ACCESS));

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    install(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? {
            data: oauthRow({
              access_token_expires_at: new Date(
                Date.now() - 1000
              ).toISOString(),
            }),
            error: null,
          }
        : { data: null, error: null }
    );

    const result = await authenticateMcpRequest(mcpRequest(OAUTH_ACCESS));

    expect((result as NextResponse).status).toBe(401);
  });

  it('rejects a token minted for a different audience', async () => {
    install(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? {
            data: oauthRow({ resource: 'https://other.example.test/api/x' }),
            error: null,
          }
        : { data: null, error: null }
    );

    const result = await authenticateMcpRequest(mcpRequest(OAUTH_ACCESS));

    expect((result as NextResponse).status).toBe(401);
  });

  it('fails closed when the audience column is null', async () => {
    install(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? { data: oauthRow({ resource: null }), error: null }
        : { data: null, error: null }
    );

    const result = await authenticateMcpRequest(mcpRequest(OAUTH_ACCESS));

    expect((result as NextResponse).status).toBe(401);
  });

  it('returns 403 insufficient_scope when the scope is too narrow', async () => {
    install(call =>
      call.table === 'oauth_tokens' && call.op === 'select'
        ? { data: oauthRow({ scope: 'mcp:read' }), error: null }
        : { data: null, error: null }
    );

    const result = await authenticateMcpRequest(mcpRequest(OAUTH_ACCESS));

    expect((result as NextResponse).status).toBe(403);
    expect((result as NextResponse).headers.get('www-authenticate')).toContain(
      'error="insufficient_scope"'
    );
  });
});

describe('unknown credentials', () => {
  it('rejects an unrecognised token prefix', async () => {
    install(() => ({ data: null, error: null }));

    const result = await authenticateMcpRequest(
      mcpRequest('wqn_unknown_' + 'c'.repeat(64))
    );

    expect((result as NextResponse).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a malformed OAuth token without querying', async () => {
    install(() => ({ data: null, error: null }));

    const result = await authenticateMcpRequest(mcpRequest('wqn_oa_short'));

    expect((result as NextResponse).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header', async () => {
    install(() => ({ data: null, error: null }));

    const result = await authenticateMcpRequest(
      new NextRequest(`${ORIGIN}/api/mcp`, { method: 'POST' })
    );

    expect((result as NextResponse).status).toBe(401);
  });
});

describe('helpers stay usable directly', () => {
  it('builds a 401 and a 403 with the right status codes', () => {
    expect(createApiTokenUnauthorizedResponse().status).toBe(401);
    expect(createApiTokenInsufficientScopeResponse().status).toBe(403);
  });
});

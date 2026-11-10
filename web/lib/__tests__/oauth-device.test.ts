import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { from, rpc, requireUser } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  requireUser: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from, rpc }),
}));
vi.mock('@/lib/supabase/requireUser', () => ({ requireUser }));
vi.mock('@/lib/oauth/locale', () => ({ resolveOAuthLocale: async () => 'en' }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    `${key}:${JSON.stringify(values ?? {})}`,
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
const { POST: start } = await import('@/app/api/oauth/device/authorize/route');
const { POST: register } = await import('@/app/api/oauth/register/route');
const { POST: token } = await import('@/app/api/oauth/token/route');
const { default: DevicePage } = await import('@/app/oauth/device/page');
const { decideDeviceAuthorization } =
  await import('@/app/oauth/device/actions');
const { DEVICE_GRANT_TYPE, generateDeviceCodes, normalizeUserCode } =
  await import('@/lib/oauth/device');
const { _resetRateLimitStore } = await import('@/lib/rate-limit');
const { installFakeSupabase } = await import('@/lib/test/fake-supabase');
import type { FakeQueryHandler } from '@/lib/test/fake-supabase';

const ORIGIN = 'https://wqn.example.test';
const CLIENT = `wqn_client_${'c'.repeat(32)}`;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const install = (handler: FakeQueryHandler) =>
  installFakeSupabase(from, handler);
function request(path: string, params: Record<string, unknown>, json = false) {
  return new NextRequest(ORIGIN + path, {
    method: 'POST',
    headers: {
      'content-type': json
        ? 'application/json'
        : 'application/x-www-form-urlencoded',
      'user-agent': 'vitest-oauth',
      'x-forwarded-for': '127.0.0.1',
    },
    body: json
      ? JSON.stringify(params)
      : new URLSearchParams(params as Record<string, string>).toString(),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitStore();
  process.env.SITE_URL = ORIGIN;
  requireUser.mockResolvedValue({ user: { id: USER } });
});

describe('browser authorization page', () => {
  it('preserves the short code through browser login', async () => {
    requireUser.mockResolvedValue({ user: null });
    await expect(
      DevicePage({ searchParams: Promise.resolve({ user_code: 'ABCD-EFGH' }) })
    ).rejects.toThrow(
      '/en/auth/login?redirect=%2Foauth%2Fdevice%3Fuser_code%3DABCD-EFGH'
    );
    expect(from).not.toHaveBeenCalled();
  });
  it('shows the requesting installation and account without changing the grant on GET', async () => {
    requireUser.mockResolvedValue({
      user: { id: USER, email: 'owner@example.test' },
    });
    const calls = install(call => ({
      data:
        call.table === 'oauth_clients'
          ? { client_name: 'My Terminal' }
          : { id: ID, client_id: CLIENT, expires_at: new Date().toISOString() },
    }));
    const markup = renderToStaticMarkup(
      await DevicePage({
        searchParams: Promise.resolve({ user_code: 'ABCD-EFGH' }),
      })
    );
    expect(markup).toContain('My Terminal');
    expect(markup).toContain('owner@example.test');
    expect(markup).toContain('ABCD');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('required');
    expect(calls.every(call => call.op === 'select')).toBe(true);
  });
  it('does not attest approval from an unverified result query parameter', async () => {
    install(() => ({ data: null }));
    const markup = renderToStaticMarkup(
      await DevicePage({
        searchParams: Promise.resolve({ result: 'approved' }),
      })
    );
    expect(markup).toContain('unavailable:');
    expect(markup).not.toContain('approved:');
    expect(from).not.toHaveBeenCalled();
  });
  it('reads a decision only for the logged-in owner', async () => {
    const calls = install(() => ({ data: { status: 'consumed' } }));
    const markup = renderToStaticMarkup(
      await DevicePage({
        searchParams: Promise.resolve({ result: 'approved', request: ID }),
      })
    );
    expect(markup).toContain('approved:');
    expect(calls[0].filters).toContainEqual(['eq', 'user_id', USER]);
    expect(calls[0].filters).toContainEqual(['eq', 'id', ID]);
  });
});

describe('device public-client registration', () => {
  it('registers a device-only installation without a callback or secret', async () => {
    const calls = install(() => ({ error: null }));
    const res = await register(
      request(
        '/api/oauth/register',
        {
          client_name: 'Terminal',
          grant_types: [DEVICE_GRANT_TYPE, 'refresh_token'],
          response_types: [],
        },
        true
      )
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirect_uris).toEqual([]);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body).not.toHaveProperty('client_secret');
    expect(calls[0].payload?.client_secret_hash).toBeNull();
  });
  it('still requires a redirect for code clients', async () => {
    install(() => ({}));
    expect(
      (
        await register(
          request('/api/oauth/register', { client_name: 'Code' }, true)
        )
      ).status
    ).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('device authorization initiation', () => {
  it('stores only hashes and binds the requested MCP resource', async () => {
    const calls = install(call =>
      call.op === 'select'
        ? { data: { client_id: CLIENT, grant_types: [DEVICE_GRANT_TYPE] } }
        : {}
    );
    const res = await start(
      request('/api/oauth/device/authorize', {
        client_id: CLIENT,
        scope: 'mcp:all',
        resource: ORIGIN + '/api/mcp',
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.device_code).toMatch(/^wqn_dc_[0-9a-f]{64}$/);
    expect(body.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBe(600);
    expect(body.verification_uri).toBe(ORIGIN + '/oauth/device');
    const saved = calls.find(call => call.op === 'insert')!.payload!;
    expect(saved.device_code_hash).toBe(hash(body.device_code));
    expect(saved.user_code_hash).toBe(hash(normalizeUserCode(body.user_code)!));
    expect(saved.resource).toBe(ORIGIN + '/api/mcp');
    expect(JSON.stringify(saved)).not.toContain(body.device_code);
    expect(JSON.stringify(saved)).not.toContain(body.user_code);
  });
  it('rejects clients that did not register the device grant', async () => {
    install(() => ({
      data: { client_id: CLIENT, grant_types: ['authorization_code'] },
    }));
    expect(
      (
        await start(
          request('/api/oauth/device/authorize', {
            client_id: CLIENT,
            resource: ORIGIN + '/api/mcp',
          })
        )
      ).status
    ).toBe(400);
  });
  it('rejects other audiences before querying client-controlled identifiers', async () => {
    install(() => ({}));
    expect(
      (
        await start(
          request('/api/oauth/device/authorize', {
            client_id: CLIENT,
            resource: 'https://other.example/api/mcp',
          })
        )
      ).status
    ).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
  it('keeps a bounded authorization-start budget', async () => {
    install(() => ({
      data: { client_id: CLIENT, grant_types: [DEVICE_GRANT_TYPE] },
    }));
    for (let i = 0; i < 20; i++) {
      await start(
        request('/api/oauth/device/authorize', {
          client_id: CLIENT,
          resource: ORIGIN + '/api/mcp',
        })
      );
    }
    expect(
      (
        await start(
          request('/api/oauth/device/authorize', {
            client_id: CLIENT,
            resource: ORIGIN + '/api/mcp',
          })
        )
      ).status
    ).toBe(429);
  });
});

describe('device token exchange', () => {
  it.each([
    'authorization_pending',
    'slow_down',
    'access_denied',
    'expired_token',
    'invalid_grant',
  ])('preserves %s from the transactional protocol', async error => {
    rpc.mockResolvedValue({ data: { error }, error: null });
    const res = await token(
      request('/api/oauth/token', {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: `wqn_dc_${'d'.repeat(64)}`,
        client_id: CLIENT,
        resource: ORIGIN + '/api/mcp',
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });
  it('returns exactly the credentials whose hashes were committed', async () => {
    rpc.mockResolvedValue({
      data: { scope: 'mcp:all', user_id: USER },
      error: null,
    });
    const res = await token(
      request('/api/oauth/token', {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: `wqn_dc_${'d'.repeat(64)}`,
        client_id: CLIENT,
        resource: ORIGIN + '/api/mcp',
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe('oauth_poll_device_authorization');
    expect(args.p_access_token_hash).toBe(hash(body.access_token));
    expect(args.p_refresh_token_hash).toBe(hash(body.refresh_token));
    expect(args.p_device_code_hash).toBe(hash(`wqn_dc_${'d'.repeat(64)}`));
    expect(args.p_refresh_ttl_seconds).toBe(90 * 86400);
    expect(body.user_id).toBe(USER);
    expect(body.expires_in).toBe(3600);
  });
  it('never releases plaintext credentials after a database failure', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'private SQL error' },
    });
    const res = await token(
      request('/api/oauth/token', {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: `wqn_dc_${'d'.repeat(64)}`,
        client_id: CLIENT,
        resource: ORIGIN + '/api/mcp',
      })
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
  });
  it('requires the canonical resource before exchanging a device code', async () => {
    const res = await token(
      request('/api/oauth/token', {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: `wqn_dc_${'d'.repeat(64)}`,
        client_id: CLIENT,
      })
    );
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('human consent', () => {
  function form(decision = 'approve') {
    const value = new FormData();
    Object.entries({
      authorization_id: ID,
      user_code: 'ABCD-EFGH',
      decision,
      confirmed: 'yes',
    }).forEach(([key, entry]) => value.set(key, entry));
    return value;
  }
  it('requires a logged-in owner and never approves on behalf of an anonymous browser', async () => {
    requireUser.mockResolvedValue({ user: null });
    await expect(decideDeviceAuthorization(form())).rejects.toThrow(
      'redirect:/oauth/device'
    );
    expect(from).not.toHaveBeenCalled();
  });
  it('binds approval to the displayed grant, short code, pending state and expiry', async () => {
    const calls = install(() => ({ data: { id: ID } }));
    await expect(decideDeviceAuthorization(form())).rejects.toThrow(
      'result=approved'
    );
    expect(calls[0].payload?.user_id).toBe(USER);
    expect(calls[0].filters).toContainEqual(['eq', 'id', ID]);
    expect(calls[0].filters).toContainEqual([
      'eq',
      'user_code_hash',
      hash('ABCDEFGH'),
    ]);
    expect(calls[0].filters).toContainEqual(['eq', 'status', 'pending']);
    expect(calls[0].filters).toContainEqual([
      'gt',
      'expires_at',
      expect.any(String),
    ]);
  });
  it('requires explicit code confirmation for approval', async () => {
    const value = form();
    value.delete('confirmed');
    await expect(decideDeviceAuthorization(value)).rejects.toThrow(
      'result=unavailable'
    );
    expect(from).not.toHaveBeenCalled();
  });
  it('allows denial without confirming the short code', async () => {
    const calls = install(() => ({ data: { id: ID } }));
    const value = form('deny');
    value.delete('confirmed');
    await expect(decideDeviceAuthorization(value)).rejects.toThrow(
      'result=denied'
    );
    expect(calls[0].payload?.status).toBe('denied');
  });
  it('does not report approval after another browser decided or the grant expired', async () => {
    install(() => ({ data: null }));
    await expect(decideDeviceAuthorization(form())).rejects.toThrow(
      'result=unavailable'
    );
  });
  it('normalizes short codes without accepting ambiguous characters', () => {
    expect(normalizeUserCode('abcd efgh')).toBe('ABCDEFGH');
    expect(normalizeUserCode('ABCD-0IO1')).toBeNull();
    const values = new Set(
      Array.from({ length: 100 }, () => generateDeviceCodes().deviceCode)
    );
    expect(values.size).toBe(100);
  });
});

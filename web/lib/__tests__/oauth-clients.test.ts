import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveCimd, mockFrom } = vi.hoisted(() => ({
  mockResolveCimd: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('@/lib/oauth/cimd', () => ({
  fetchClientMetadataDocument: mockResolveCimd,
  isCimdClientId: (id: string) => /^https:\/\//i.test(id),
  CimdError: class CimdError extends Error {
    reason: string;
    constructor(message: string, reason = 'unknown') {
      super(message);
      this.reason = reason;
    }
  },
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom }),
}));

const { resolveClient, clientAllowsRedirectUri } = await import(
  '@/lib/oauth/clients'
);
const { CimdError } = await import('@/lib/oauth/cimd');
const { installFakeSupabase } = await import('@/lib/test/fake-supabase');
import type { FakeQueryHandler } from '@/lib/test/fake-supabase';

const CIMD_CLIENT = 'https://chatgpt.com/oauth/client.json';
const OPAQUE_CLIENT = 'wqn_client_' + 'a'.repeat(32);

function install(handler: FakeQueryHandler) {
  return installFakeSupabase(mockFrom as never, handler);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing stored.
  install(() => ({ data: null, error: null }));
  mockResolveCimd.mockResolvedValue({
    clientId: CIMD_CLIENT,
    clientName: 'ChatGPT',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  });
});

describe('resolution order', () => {
  it('prefers a stored row over the live CIMD document', async () => {
    install(call =>
      call.op === 'select'
        ? {
            data: {
              client_id: CIMD_CLIENT,
              client_name: 'ChatGPT (pinned)',
              redirect_uris: ['https://chatgpt.com/a', 'https://chatgpt.com/b'],
            },
            error: null,
          }
        : { data: null, error: null }
    );

    const result = await resolveClient(CIMD_CLIENT);

    // This is the deliberate inversion: a pinned row lets an operator keep a
    // client working when its metadata host is unreachable from here.
    expect(result?.clientName).toBe('ChatGPT (pinned)');
    expect(mockResolveCimd).not.toHaveBeenCalled();
  });

  it('falls back to CIMD when the client is not stored', async () => {
    const result = await resolveClient(CIMD_CLIENT);

    expect(result).toMatchObject({ clientName: 'ChatGPT', source: 'cimd' });
    expect(mockResolveCimd).toHaveBeenCalledWith(CIMD_CLIENT);
  });

  it('never fetches for an opaque client id', async () => {
    install(call =>
      call.op === 'select'
        ? {
            data: {
              client_id: OPAQUE_CLIENT,
              client_name: 'Local Client',
              redirect_uris: ['https://a.test/cb'],
            },
            error: null,
          }
        : { data: null, error: null }
    );

    const result = await resolveClient(OPAQUE_CLIENT);

    expect(result?.source).toBe('database');
    expect(mockResolveCimd).not.toHaveBeenCalled();
  });

  it('returns null when neither the database nor CIMD knows the client', async () => {
    mockResolveCimd.mockRejectedValue(new Error('unreachable'));

    expect(await resolveClient(CIMD_CLIENT)).toBeNull();
  });

  it('returns null when an opaque id is unknown', async () => {
    expect(await resolveClient(OPAQUE_CLIENT)).toBeNull();
    expect(mockResolveCimd).not.toHaveBeenCalled();
  });

  it('surfaces the reason so operators can tell blocked egress from a bad document', async () => {
    const { logger } = await import('@/lib/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockResolveCimd.mockRejectedValue(
      new CimdError('host is unreachable (ECONNREFUSED)', 'unreachable')
    );

    await resolveClient(CIMD_CLIENT);

    expect(warn).toHaveBeenCalledWith(
      'Client ID metadata document rejected',
      expect.objectContaining({ reason: 'unreachable' })
    );
    warn.mockRestore();
  });
});

describe('redirect URI matching', () => {
  const client = {
    clientId: OPAQUE_CLIENT,
    clientName: 'Local Client',
    redirectUris: ['https://a.test/cb', 'cursor://x/cb'],
    source: 'database' as const,
  };

  it('matches byte for byte', () => {
    expect(clientAllowsRedirectUri(client, 'https://a.test/cb')).toBe(true);
    expect(clientAllowsRedirectUri(client, 'https://a.test/cb/')).toBe(false);
    expect(clientAllowsRedirectUri(client, 'https://a.test/cb?x=1')).toBe(
      false
    );
    // A prefix match here is how code interception gets in.
    expect(
      clientAllowsRedirectUri(client, 'https://a.test/cb.evil.test')
    ).toBe(false);
  });

  it('accepts a registered custom scheme', () => {
    expect(clientAllowsRedirectUri(client, 'cursor://x/cb')).toBe(true);
  });
});

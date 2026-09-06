import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLookup, mockFetch } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

import { CimdError, fetchClientMetadataDocument } from '@/lib/oauth/cimd';

const CLIENT_ID = 'https://client.example.com/oauth/metadata.json';

function validDocument(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: 'Example MCP Client',
    redirect_uris: ['https://client.example.com/callback'],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every address resolves to a public IP unless a test says otherwise. */
function resolveToPublic() {
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveToPublic();
  // mockImplementation (not mockResolvedValue) so each call gets a fresh
  // Response -- a response body stream can only be read once.
  mockFetch.mockImplementation(() => jsonResponse(validDocument()));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Client ID Metadata Document fetch', () => {
  it('returns the document metadata for a well formed response', async () => {
    const result = await fetchClientMetadataDocument(CLIENT_ID);

    expect(result).toEqual({
      clientId: CLIENT_ID,
      clientName: 'Example MCP Client',
      redirectUris: ['https://client.example.com/callback'],
    });
  });

  it('falls back to the hostname when the document omits client_name', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        client_id: CLIENT_ID,
        redirect_uris: ['https://a.test/cb'],
      })
    );

    const result = await fetchClientMetadataDocument(CLIENT_ID);

    expect(result.clientName).toBe('client.example.com');
  });

  it('requires the document to claim the exact URL it was fetched from', async () => {
    mockFetch.mockImplementation(() =>
      jsonResponse(
        validDocument({ client_id: 'https://evil.example.com/metadata.json' })
      )
    );

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      CimdError
    );
    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      /does not match/
    );
  });

  it('rejects a redirect instead of following it', async () => {
    // A 302 to an internal host would bypass the address check, so redirects
    // are refused outright rather than followed.
    mockFetch.mockResolvedValue(new Response(null, { status: 302 }));

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      CimdError
    );
  });

  it('rejects a non-JSON content type', async () => {
    mockFetch.mockResolvedValue(
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      /not JSON/
    );
  });

  it('rejects a document larger than the size cap', async () => {
    mockFetch.mockResolvedValue(
      new Response('a'.repeat(70000), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      /size limit/
    );
  });

  it('rejects a document with an unsupported redirect_uri', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(validDocument({ redirect_uris: ['javascript:alert(1)'] }))
    );

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      /redirect_uri/
    );
  });

  it('rejects non-HTTPS client_id URLs', async () => {
    await expect(
      fetchClientMetadataDocument('http://client.example.com/metadata.json')
    ).rejects.toThrow(/HTTPS/);
  });

  it('rejects URLs carrying credentials', async () => {
    await expect(
      fetchClientMetadataDocument(
        'https://user:pass@client.example.com/metadata.json'
      )
    ).rejects.toThrow(/credentials/);
  });
});

function fetchFailure(error: unknown): never {
  throw error;
}

describe('failure classification', () => {
  // A collapsed "fetch failed" is useless to an operator: a blocked egress
  // firewall, a dead resolver and a slow host need different responses.
  // Node's fetch wraps every network error as `TypeError: fetch failed` and
  // puts the real code on `cause`. This is the exact shape produced by a
  // blocked egress firewall or a dead resolver.
  function undiciFailure(code: string): TypeError {
    const cause = new Error('connect failed');
    (cause as NodeJS.ErrnoException).code = code;
    const error = new TypeError('fetch failed');
    (error as unknown as { cause: unknown }).cause = cause;
    return error;
  }

  it.each([
    ['timeout', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['dns', Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })],
    ['dns', Object.assign(new Error('getaddrinfo'), { code: 'EAI_AGAIN' })],
    [
      'unreachable',
      Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    ],
    [
      'tls',
      Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }),
    ],
    // The production shape: a bare TypeError with the code on `cause`.
    ['dns', undiciFailure('ENOTFOUND')],
    ['unreachable', undiciFailure('ECONNREFUSED')],
    ['timeout', undiciFailure('ETIMEDOUT')],
    ['unreachable', undiciFailure('UND_ERR_CONNECT_TIMEOUT')],
    ['tls', undiciFailure('CERT_HAS_EXPIRED')],
  ])('classifies a %s failure', async (expected, error) => {
    mockFetch.mockImplementation(() => fetchFailure(error));

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toMatchObject({
      reason: expected,
    });
  });

  it('finds the code several links down the cause chain', async () => {
    const deep = Object.assign(new Error('leaf'), { code: 'ENOTFOUND' });
    const middle = new Error('middle') as NodeJS.ErrnoException & {
      cause?: unknown;
    };
    const top = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    middle.cause = deep;
    top.cause = middle;

    mockFetch.mockImplementation(() => fetchFailure(top));

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toMatchObject({
      reason: 'dns',
    });
  });

  it('does not loop on a self-referential cause chain', async () => {
    const a = new Error('a') as NodeJS.ErrnoException & { cause?: unknown };
    const b = new Error('b') as NodeJS.ErrnoException & { cause?: unknown };
    a.cause = b;
    b.cause = a;

    mockFetch.mockImplementation(() => fetchFailure(a));

    // Must settle rather than hang.
    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toMatchObject({
      reason: 'unknown',
    });
  });

  it('classifies a non-200 response separately from a network failure', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('nope', { status: 403 }))
    );

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toMatchObject({
      reason: 'http_status',
    });
  });

  it('keeps the machine-readable reason out of the user-facing message', async () => {
    mockFetch.mockImplementation(() =>
      fetchFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))
    );

    const error = await fetchClientMetadataDocument(CLIENT_ID).catch(e => e);

    // The reason is for logs; the message tells a human what happened.
    expect(error.message).toContain('ENOTFOUND');
    expect(error.reason).toBe('dns');
  });
});

describe('SSRF protection', () => {
  const blockedLiterals = [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.1',
    '172.16.0.5',
    '169.254.169.254', // cloud instance metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    '::1',
    'fc00::1', // unique local
    'fe80::1', // link local
    '2001:db8::1', // documentation
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ];

  it.each(blockedLiterals)('blocks a literal address: %s', async literal => {
    // Literal addresses are checked without a DNS lookup, so a hostile
    // resolver cannot influence the outcome.
    // IPv6 literals need brackets in a URL; IPv4 literals must not have them.
    const url = literal.includes(':')
      ? `https://[${literal}]/metadata.json`
      : `https://${literal}/metadata.json`;
    await expect(fetchClientMetadataDocument(url)).rejects.toThrow(
      /private address/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks a public IPv4 literal that is allowed through', async () => {
    const url = 'https://93.184.216.34/metadata.json';
    mockFetch.mockResolvedValue(
      jsonResponse({ client_id: url, redirect_uris: ['https://a.test/cb'] })
    );

    await expect(fetchClientMetadataDocument(url)).resolves.toBeTruthy();
  });

  it('blocks a hostname that resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      /private address/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks when any resolved address is private', async () => {
    // A single private answer among public ones must still be fatal.
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      /private address/
    );
  });

  it('blocks when the hostname does not resolve', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(fetchClientMetadataDocument(CLIENT_ID)).rejects.toThrow(
      /private address/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

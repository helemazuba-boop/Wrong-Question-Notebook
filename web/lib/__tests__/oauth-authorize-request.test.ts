import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    security: vi.fn(),
  },
}));

const { parseAuthorizationRequest, parseAuthorizationRequestFromFormData } =
  await import('@/lib/oauth/authorize-request');
const { verifyPkceS256 } = await import('@/lib/oauth/service');
const { logger } = await import('@/lib/logger');

const ORIGIN = 'https://wqn.example.test';
const RESOURCE = `${ORIGIN}/api/mcp`;
const CLIENT_ID = 'wqn_client_' + 'a'.repeat(32);
const REDIRECT_URI = 'https://client.example.test/callback';

process.env.SITE_URL = ORIGIN;

/** A genuine S256 challenge: base64url(SHA256(verifier)), always 43 chars. */
const VERIFIER = 'abcdefghij' + 'k'.repeat(35);
const CANONICAL = createHash('sha256').update(VERIFIER).digest('base64url');

function baseParams(
  overrides: Record<string, string | null> = {}
): Record<string, string | null> {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CANONICAL,
    code_challenge_method: 'S256',
    ...overrides,
  };
}

describe('happy path', () => {
  it('accepts a canonical S256 request', () => {
    const result = parseAuthorizationRequest(baseParams());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.codeChallenge).toBe(CANONICAL);
    expect(result.request.scope).toBe('mcp:all');
    expect(result.request.resource).toBe(RESOURCE);
    expect(result.request.state).toBeNull();
  });

  it('takes the first value when a parameter is repeated', () => {
    const result = parseAuthorizationRequest({
      ...baseParams(),
      client_id: [CLIENT_ID, 'wqn_client_second'] as unknown as string,
    } as Record<string, string | string[] | null>);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.clientId).toBe(CLIENT_ID);
  });

  it('defaults scope and resource when the client omits them', () => {
    const result = parseAuthorizationRequest({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CANONICAL,
      code_challenge_method: 'S256',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.scope).toBe('mcp:all');
    expect(result.request.resource).toBe(RESOURCE);
  });
});

describe('PKCE parameter handling', () => {
  it('accepts a lower-case code_challenge_method', () => {
    // RFC 7636 registers the value case-insensitively and clients do send
    // `s256`; rejecting it would break them for no security gain.
    const result = parseAuthorizationRequest(
      baseParams({ code_challenge_method: 's256' })
    );

    expect(result.ok).toBe(true);
  });

  it('reports the missing method distinctly from a wrong one', () => {
    const missing = parseAuthorizationRequest(
      baseParams({ code_challenge_method: null })
    );
    const wrong = parseAuthorizationRequest(
      baseParams({ code_challenge_method: 'plain' })
    );

    expect(missing).toMatchObject({
      error: 'invalid_request',
      detail: 'missing_code_challenge_method',
    });
    expect(wrong).toMatchObject({
      error: 'invalid_request',
      detail: 'code_challenge_method_not_s256',
    });
  });

  it('accepts a padded challenge and stores the canonical form', () => {
    const padded = `${CANONICAL}=`;
    expect(padded).toHaveLength(44);

    const result = parseAuthorizationRequest(
      baseParams({ code_challenge: padded })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.codeChallenge).toBe(CANONICAL);
  });

  it('accepts the standard base64 alphabet and normalises it', () => {
    // 32 bytes encode to 44 base64 characters with a single padding char.
    const standard = `${CANONICAL.replace(/-/g, '+').replace(/_/g, '/')}=`;
    expect(standard).toHaveLength(44);

    const result = parseAuthorizationRequest(
      baseParams({ code_challenge: standard })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.codeChallenge).toBe(CANONICAL);
  });

  it('lets a padded challenge still verify at the token endpoint', () => {
    // The whole point of canonicalising at ingress: the client that padded
    // its challenge must still be able to exchange the code.
    const result = parseAuthorizationRequest(
      baseParams({ code_challenge: `${CANONICAL}=` })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(verifyPkceS256(VERIFIER, result.request.codeChallenge)).toBe(true);
  });

  it('rejects a challenge that is not a SHA-256 digest', () => {
    // 128 characters is within the RFC 7636 length range for a *verifier*,
    // but an S256 challenge is always 43. Accepting it would only move the
    // failure to the token endpoint where the reason is invisible.
    const result = parseAuthorizationRequest(
      baseParams({ code_challenge: 'a'.repeat(128) })
    );

    expect(result).toMatchObject({
      error: 'invalid_request',
      detail: 'malformed_code_challenge',
    });
  });

  it('rejects a challenge that is too short', () => {
    const result = parseAuthorizationRequest(
      baseParams({ code_challenge: 'a'.repeat(42) })
    );

    expect(result).toMatchObject({ detail: 'malformed_code_challenge' });
  });

  it('rejects characters outside the base64 alphabets', () => {
    for (const bad of [`${CANONICAL.slice(0, 42)}*`, `${CANONICAL} `]) {
      const result = parseAuthorizationRequest(
        baseParams({ code_challenge: bad })
      );
      expect(result, bad).toMatchObject({ detail: 'malformed_code_challenge' });
    }
  });

  it('reports a missing challenge distinctly from a malformed one', () => {
    const result = parseAuthorizationRequest(
      baseParams({ code_challenge: null })
    );

    expect(result).toMatchObject({
      error: 'invalid_request',
      detail: 'missing_code_challenge',
    });
  });
});

describe('other parameter validation', () => {
  it('requires client_id and redirect_uri', () => {
    expect(
      parseAuthorizationRequest(baseParams({ client_id: null }))
    ).toMatchObject({ detail: 'missing_client_id' });
    expect(
      parseAuthorizationRequest(baseParams({ redirect_uri: null }))
    ).toMatchObject({ detail: 'missing_redirect_uri' });
  });

  it('caps client_id length', () => {
    const result = parseAuthorizationRequest(
      baseParams({ client_id: 'a'.repeat(2049) })
    );

    expect(result).toMatchObject({ detail: 'client_id_too_long' });
  });

  it('rejects anything but the authorization code flow', () => {
    const result = parseAuthorizationRequest(
      baseParams({ response_type: 'token' })
    );

    expect(result).toMatchObject({
      error: 'unsupported_response_type',
      detail: 'response_type_not_code',
    });
  });

  it('allows a long state but caps it', () => {
    // `state` is opaque and merely echoed, so realistic client blobs have to
    // fit; the cap is a DoS bound, not a spec requirement.
    expect(
      parseAuthorizationRequest(baseParams({ state: 's'.repeat(4096) })).ok
    ).toBe(true);
    expect(
      parseAuthorizationRequest(baseParams({ state: 's'.repeat(4097) }))
    ).toMatchObject({ detail: 'state_too_long' });
  });

  it('logs the observed state length but never the value', () => {
    vi.mocked(logger.warn).mockClear();

    parseAuthorizationRequest(baseParams({ state: 's'.repeat(5000) }));

    expect(logger.warn).toHaveBeenCalledWith(
      'OAuth authorization request rejected',
      expect.objectContaining({
        detail: 'state_too_long',
        stateLength: 5000,
      })
    );
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain('s'.repeat(100));
  });

  it('rejects an unsupported scope', () => {
    const result = parseAuthorizationRequest(
      baseParams({ scope: 'mcp:read mcp:write' })
    );

    expect(result).toMatchObject({
      error: 'invalid_scope',
      detail: 'unsupported_scope',
    });
  });

  it('rejects a resource this server does not protect', () => {
    const result = parseAuthorizationRequest(
      baseParams({ resource: 'https://other.example.test/api/x' })
    );

    expect(result).toMatchObject({
      error: 'invalid_target',
      detail: 'unknown_resource',
    });
  });
});

describe('form data parsing', () => {
  it('reads the same fields back out of a submitted form', () => {
    const form = new FormData();
    form.set('response_type', 'code');
    form.set('client_id', CLIENT_ID);
    form.set('redirect_uri', REDIRECT_URI);
    form.set('code_challenge', CANONICAL);
    form.set('code_challenge_method', 'S256');
    form.set('scope', 'mcp:all');
    form.set('resource', RESOURCE);

    const result = parseAuthorizationRequestFromFormData(form);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      state: null,
      codeChallenge: CANONICAL,
      scope: 'mcp:all',
      resource: RESOURCE,
    });
  });

  it('re-validates rather than trusting what the page rendered', () => {
    const form = new FormData();
    form.set('response_type', 'code');
    form.set('client_id', CLIENT_ID);
    form.set('redirect_uri', REDIRECT_URI);
    form.set('code_challenge', 'tampered');
    form.set('code_challenge_method', 'S256');

    expect(parseAuthorizationRequestFromFormData(form)).toMatchObject({
      detail: 'malformed_code_challenge',
    });
  });
});

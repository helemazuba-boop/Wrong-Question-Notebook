import { createHash, randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  generateAuthorizationCode,
  generateClientId,
  generateOAuthAccessToken,
  generateOAuthRefreshToken,
  hashOAuthSecret,
  isAuthorizationCode,
  isOAuthAccessToken,
  isOAuthRefreshToken,
  isValidCodeVerifier,
  isValidRedirectUri,
  verifyPkceS256,
} from '@/lib/oauth/service';

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('credential format', () => {
  it('mints prefixed 256-bit secrets that pass their own validators', () => {
    const accessToken = generateOAuthAccessToken();
    const refreshToken = generateOAuthRefreshToken();
    const code = generateAuthorizationCode();

    expect(isOAuthAccessToken(accessToken)).toBe(true);
    expect(isOAuthRefreshToken(refreshToken)).toBe(true);
    expect(isAuthorizationCode(code)).toBe(true);
  });

  it('rejects a valid-looking prefix without the full entropy', () => {
    expect(isOAuthAccessToken(`wqn_oa_${'a'.repeat(63)}`)).toBe(false);
    expect(isOAuthAccessToken(`wqn_oa_${'z'.repeat(64)}`)).toBe(false);
    expect(isOAuthRefreshToken('wqn_oa_' + 'a'.repeat(64))).toBe(false);
  });

  it('hashes to lowercase hex so the SQL format constraint holds', () => {
    const digest = hashOAuthSecret(generateOAuthAccessToken());

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issues client ids that are distinct from credential formats', () => {
    const clientId = generateClientId();

    expect(clientId).toMatch(/^wqn_client_[0-9a-f]{32}$/);
    expect(isOAuthAccessToken(clientId)).toBe(false);
  });

  it('keeps access tokens short-lived relative to refresh tokens', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
    expect(AUTHORIZATION_CODE_TTL_SECONDS).toBeLessThanOrEqual(10 * 60);
  });
});

describe('PKCE verification', () => {
  it('accepts the verifier that produced the challenge', () => {
    const verifier = randomBytes(32).toString('base64url');

    expect(verifyPkceS256(verifier, challengeFor(verifier))).toBe(true);
  });

  it('rejects a different verifier', () => {
    const verifier = randomBytes(32).toString('base64url');
    const other = randomBytes(32).toString('base64url');

    expect(verifyPkceS256(other, challengeFor(verifier))).toBe(false);
  });

  it('rejects a challenge of the wrong length instead of throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths, so this guards the
    // length pre-check that keeps client input from crashing the endpoint.
    const verifier = randomBytes(32).toString('base64url');

    expect(() => verifyPkceS256(verifier, 'short')).not.toThrow();
    expect(verifyPkceS256(verifier, 'short')).toBe(false);
  });

  it('rejects verifiers outside the RFC 7636 character set and length', () => {
    expect(isValidCodeVerifier(randomBytes(32).toString('base64url'))).toBe(
      true
    );
    // 42 characters: one below the minimum.
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    // 129 characters: one above the maximum.
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    // Reserved characters (+, /, =) are not in the unreserved set.
    expect(isValidCodeVerifier('a'.repeat(42) + '+')).toBe(false);
  });
});

describe('redirect_uri validation', () => {
  it('accepts https callbacks', () => {
    expect(isValidRedirectUri('https://example.com/oauth/callback')).toBe(true);
  });

  it('accepts loopback http for native clients', () => {
    expect(isValidRedirectUri('http://127.0.0.1:33418/callback')).toBe(true);
    expect(isValidRedirectUri('http://localhost:33418/callback')).toBe(true);
    expect(isValidRedirectUri('http://[::1]:33418/callback')).toBe(true);
  });

  it('rejects plain http anywhere else', () => {
    expect(isValidRedirectUri('http://example.com/callback')).toBe(false);
    // 127.0.0.2 is loopback-adjacent but must not be treated as loopback.
    expect(isValidRedirectUri('http://127.0.0.2:33418/callback')).toBe(false);
  });

  it('rejects schemes that would execute rather than redirect', () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://example.com/x',
      'vbscript:msgbox(1)',
    ]) {
      expect(isValidRedirectUri(uri), uri).toBe(false);
    }
  });

  it('accepts private-use URI schemes used by desktop clients', () => {
    expect(
      isValidRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')
    ).toBe(true);
  });

  it('rejects a bare scheme with nothing to route to', () => {
    expect(isValidRedirectUri('cursor:')).toBe(false);
  });

  it('rejects fragments as RFC 6749 requires', () => {
    expect(isValidRedirectUri('https://example.com/callback#token')).toBe(
      false
    );
  });

  it('rejects values that are not URLs at all', () => {
    expect(isValidRedirectUri('')).toBe(false);
    expect(isValidRedirectUri('not a url')).toBe(false);
    expect(isValidRedirectUri(`https://example.com/${'a'.repeat(3000)}`)).toBe(
      false
    );
  });
});

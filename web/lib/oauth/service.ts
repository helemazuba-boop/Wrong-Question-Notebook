import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getAppOrigin } from '@/lib/app-origin';
import { MCP_RESOURCE_URL, OAUTH_SCOPES_SUPPORTED } from './constants';

// Secret minting and verification for the built-in OAuth 2.1 authorization
// server.
//
// Every credential is a 256-bit random string behind a stable prefix: the
// prefix lets a leaked value be recognised by a secret scanner and lets the
// MCP endpoint dispatch on format, while the digest stored in the database is
// SHA-256 over the whole string. SHA-256 (not a slow KDF) is deliberate and
// matches api-token.ts / esp32-token.ts -- there is no low-entropy password
// here to protect.

export const OAUTH_ACCESS_TOKEN_PREFIX = 'wqn_oa_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'wqn_rt_';
export const OAUTH_AUTHORIZATION_CODE_PREFIX = 'wqn_code_';
export const OAUTH_CLIENT_ID_PREFIX = 'wqn_client_';

const ACCESS_TOKEN_PATTERN = /^wqn_oa_[0-9a-f]{64}$/;
const REFRESH_TOKEN_PATTERN = /^wqn_rt_[0-9a-f]{64}$/;
const AUTHORIZATION_CODE_PATTERN = /^wqn_code_[0-9a-f]{64}$/;

// RFC 7636 section 4.1: 43-128 characters from the unreserved set.
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

// Accepted shapes of an incoming code_challenge before canonicalisation: the
// unreserved base64url alphabet plus the standard-base64 alphabet and padding,
// so a client that pads or uses `+`/`/` is still understood.
const CODE_CHALLENGE_INPUT_PATTERN = /^[A-Za-z0-9_+\/\-=]{43,128}$/;

/**
 * Access tokens are short-lived because they cannot be revoked cheaply once
 * a client has cached one; refresh token rotation is what makes that
 * tolerable. Refresh tokens live longer precisely because reuse detection can
 * revoke them.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function generateOAuthAccessToken(): string {
  return `${OAUTH_ACCESS_TOKEN_PREFIX}${randomHex(32)}`;
}

export function generateOAuthRefreshToken(): string {
  return `${OAUTH_REFRESH_TOKEN_PREFIX}${randomHex(32)}`;
}

export function generateAuthorizationCode(): string {
  return `${OAUTH_AUTHORIZATION_CODE_PREFIX}${randomHex(32)}`;
}

export function generateClientId(): string {
  return `${OAUTH_CLIENT_ID_PREFIX}${randomHex(16)}`;
}

/** SHA-256 hex digest, matching the `^[0-9a-f]{64}$` constraints in SQL. */
export function hashOAuthSecret(secret: string): string {
  // Access, refresh and authorization credentials contain 256 random bits; no human password reaches this digest.
  return createHash('sha256').update(secret).digest('hex');
}

export function isOAuthAccessToken(token: string): boolean {
  return ACCESS_TOKEN_PATTERN.test(token);
}

export function isOAuthRefreshToken(token: string): boolean {
  return REFRESH_TOKEN_PATTERN.test(token);
}

export function isAuthorizationCode(code: string): boolean {
  return AUTHORIZATION_CODE_PATTERN.test(code);
}

export function isValidCodeVerifier(verifier: string): boolean {
  return CODE_VERIFIER_PATTERN.test(verifier);
}

/**
 * Canonicalise a PKCE `code_challenge` to bare base64url.
 *
 * SHA-256 is 32 bytes, so an S256 challenge is *always* exactly 43 base64url
 * characters. Real clients still send other encodings of the same digest --
 * base64 with `=` padding (44 chars), or standard base64 using `+` and `/`
 * instead of `-` and `_`. Those are the same 256 bits, so they are accepted
 * and rewritten into the canonical form.
 *
 * The result must be 43 characters. Anything longer is not a SHA-256 digest
 * and could never verify at the token endpoint, so it is rejected here where
 * the reason is still visible to the user instead of failing later as an
 * opaque invalid_grant.
 *
 * Returns null when the input is not a usable challenge.
 */
export function normalizeCodeChallenge(raw: string): string | null {
  if (!CODE_CHALLENGE_INPUT_PATTERN.test(raw)) return null;

  const canonical = raw
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return canonical.length === 43 ? canonical : null;
}

/**
 * RFC 7636 S256 verification.
 *
 * Length is compared before timingSafeEqual because that function throws on
 * buffers of differing length, and the challenge comes from client input.
 *
 * The stored challenge is already canonical base64url (see
 * normalizeCodeChallenge), so this stays a plain comparison.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(
    createHash('sha256').update(verifier).digest('base64url')
  );
  const expected = Buffer.from(challenge);
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

/**
 * Canonical URI of the protected resource (RFC 8707).
 *
 * Tokens are bound to this exact string; comparisons elsewhere are byte-exact
 * so that a token minted for a different audience is rejected.
 */
export function getMcpResourceUri(): string {
  return `${getAppOrigin()}${MCP_RESOURCE_URL}`;
}

/** True when the client asked for exactly the resource this server protects. */
export function isExpectedResource(resource: string | null): boolean {
  return resource === getMcpResourceUri();
}

export const DEFAULT_OAUTH_SCOPE = OAUTH_SCOPES_SUPPORTED.join(' ');

/**
 * True when the granted scope covers everything the MCP tools require.
 *
 * A NULL or empty scope is a denial: the token store predates the scope
 * column for rows created before it existed, and silently treating those as
 * fully scoped would undercut the consent screen.
 */
export function hasRequiredMcpScope(scope: string | null): boolean {
  if (!scope) return false;
  const granted = scope.split(/\s+/).filter(Boolean);
  return OAUTH_SCOPES_SUPPORTED.every(required => granted.includes(required));
}

const FORBIDDEN_URI_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'file:',
  'blob:',
  'about:',
  'vbscript:',
]);

// RFC 8252 section 7.3 allows a loopback redirect for native clients; plain
// http anywhere else would put an authorization code on the wire in cleartext.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// Private-use URI scheme (RFC 8252 section 7.1), e.g. cursor://... Desktop
// clients register these because they cannot own an HTTPS callback.
const PRIVATE_USE_SCHEME_PATTERN = /^[a-z][a-z0-9+\-.]*:$/;

const MAX_REDIRECT_URI_LENGTH = 2048;

/**
 * Validate a redirect URI offered at registration or authorization time.
 *
 * Matching later is a byte-exact comparison against the registered list, so
 * wildcards never apply. The scheme allowlist is the part that matters: an
 * accepted `javascript:` or `data:` URI would turn the consent redirect into
 * script execution in the user's browser.
 */
export function isValidRedirectUri(uri: string): boolean {
  if (typeof uri !== 'string') return false;
  if (uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) return false;
  // RFC 6749 section 3.1.2: the URI MUST NOT include a fragment.
  if (uri.includes('#')) return false;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (FORBIDDEN_URI_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return LOOPBACK_HOSTNAMES.has(parsed.hostname);
  }
  if (!PRIVATE_USE_SCHEME_PATTERN.test(parsed.protocol)) return false;

  // Reject a bare "scheme:" with nothing to route to.
  return parsed.host !== '' || parsed.pathname !== '';
}

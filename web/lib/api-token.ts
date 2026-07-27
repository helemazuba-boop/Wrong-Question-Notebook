import { createHash } from 'crypto';

// Personal access tokens for the public MCP endpoint. Format:
//   wqn_mcp_<64 lowercase hex chars>  (randomBytes(32))
// The prefix makes leaked tokens identifiable by secret scanners; the digest
// covers the whole string so the stored hash never matches a bare hex blob.

export const API_TOKEN_PREFIX = 'wqn_mcp_';

const API_TOKEN_PATTERN = /^wqn_mcp_[0-9a-f]{64}$/;

export function isValidApiToken(token: string): boolean {
  return API_TOKEN_PATTERN.test(token);
}

/**
 * Hash an MCP access token for storage / lookup.
 *
 * The user sees the plaintext exactly once at creation time and sends it back
 * as a Bearer credential on every /api/mcp request. The server stores only
 * this SHA-256 digest and compares digests on auth.
 *
 * SHA-256 (not bcrypt/scrypt) is appropriate because tokens are 256-bit
 * high-entropy random strings, so there is no password-strength concern to
 * offset with a slow KDF (same reasoning as esp32-token.ts).
 */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

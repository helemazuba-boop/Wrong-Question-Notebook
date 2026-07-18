import { createHash } from 'crypto';

/**
 * Hash a device access token for storage / lookup.
 *
 * Devices receive the plaintext token once at pairing time (returned by
 * /api/esp32/poll) and send it back as a Bearer credential on every request.
 * The server never stores the plaintext - it stores this SHA-256 digest and
 * compares digests on auth.
 *
 * SHA-256 (not bcrypt/scrypt) is appropriate here because pairing tokens are
 * 256-bit high-entropy random strings (`randomBytes(32)`), so there is no
 * password-strength concern to offset with a slow KDF.
 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

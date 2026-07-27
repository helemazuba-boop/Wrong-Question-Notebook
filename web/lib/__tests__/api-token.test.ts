import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_PREFIX,
  hashApiToken,
  isValidApiToken,
} from '@/lib/api-token';

const HEX_64 = 'a'.repeat(64);

describe('isValidApiToken', () => {
  it('accepts the canonical format', () => {
    expect(isValidApiToken(`${API_TOKEN_PREFIX}${HEX_64}`)).toBe(true);
  });

  it('rejects a bare hex token without the prefix', () => {
    expect(isValidApiToken(HEX_64)).toBe(false);
  });

  it('rejects the wrong prefix', () => {
    expect(isValidApiToken(`wqn_dev_${HEX_64}`)).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(isValidApiToken(`${API_TOKEN_PREFIX}${'A'.repeat(64)}`)).toBe(false);
  });

  it('rejects wrong hex length', () => {
    expect(isValidApiToken(`${API_TOKEN_PREFIX}${'a'.repeat(63)}`)).toBe(false);
    expect(isValidApiToken(`${API_TOKEN_PREFIX}${'a'.repeat(65)}`)).toBe(false);
  });

  it('rejects surrounding whitespace', () => {
    expect(isValidApiToken(` ${API_TOKEN_PREFIX}${HEX_64}`)).toBe(false);
  });
});

describe('hashApiToken', () => {
  it('is deterministic and 64-hex shaped', () => {
    const token = `${API_TOKEN_PREFIX}${HEX_64}`;
    const digest = hashApiToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiToken(token)).toBe(digest);
  });

  it('covers the prefix so a bare hex blob hashes differently', () => {
    expect(hashApiToken(`${API_TOKEN_PREFIX}${HEX_64}`)).not.toBe(
      hashApiToken(HEX_64)
    );
  });
});

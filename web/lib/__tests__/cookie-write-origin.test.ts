import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTrustedWriteOrigin } from '@/lib/cookie-write-origin';

beforeEach(() => {
  vi.stubEnv('SITE_URL', 'https://wqn.example');
});
afterEach(() => vi.unstubAllEnvs());

const request = (origin?: string) =>
  new Request('http://0.0.0.0:3000/api/mcp/operations/test', {
    headers: origin === undefined ? {} : { origin },
  });

describe('cookie write origin', () => {
  it('uses the configured public origin rather than the upstream URL', () => {
    expect(isTrustedWriteOrigin(request('https://wqn.example'))).toBe(true);
  });
  it.each([
    'https://attacker.example',
    'https://wqn.example.attacker.example',
    'http://wqn.example',
    'https://wqn.example:444',
    'https://wqn.example/path',
    'null',
    'http://0.0.0.0:3000',
  ])('rejects an untrusted origin %s', origin => {
    expect(isTrustedWriteOrigin(request(origin))).toBe(false);
  });
  it('retains cookie-authenticated clients that omit Origin', () => {
    expect(isTrustedWriteOrigin(request())).toBe(true);
  });
  it('fails closed when the production public origin is not configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const name of [
      'SITE_URL',
      'NEXT_PUBLIC_APP_URL',
      'NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL',
    ])
      vi.stubEnv(name, '');
    expect(isTrustedWriteOrigin(request('http://0.0.0.0:3000'))).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { buildContentSecurityPolicy } from '../security-policy';

describe('configured Supabase CSP origin', () => {
  it('can load shared browser constants without private server environment variables', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.e2e.test:8444');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY', 'test-public');
    vi.stubEnv('WQN_SUPABASE_EXPECTED_HOST', undefined);
    vi.resetModules();
    try {
      const shared = await import('../security-policy');
      expect(shared.CONTENT_SECURITY_POLICY).toContain(
        "frame-ancestors 'none'"
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  const input = {
    url: 'https://supabase.e2e.test:8444',
    publishableKey: 'test-public',
    expectedHost: 'supabase.e2e.test',
    nodeEnv: 'production',
  };
  it('allows only the validated configured HTTP and WebSocket origins', () => {
    const policy = buildContentSecurityPolicy(input);
    expect(policy).toContain('https://supabase.e2e.test:8444');
    expect(policy).toContain('wss://supabase.e2e.test:8444');
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('connect-src *');
  });
  it('rejects a host mismatch, an insecure origin and CSP injection', () => {
    expect(() =>
      buildContentSecurityPolicy({ ...input, expectedHost: 'other.test' })
    ).toThrow();
    expect(() =>
      buildContentSecurityPolicy({
        ...input,
        url: 'http://supabase.e2e.test:8444',
      })
    ).toThrow();
    expect(() =>
      buildContentSecurityPolicy({
        ...input,
        url: 'https://test; connect-src *',
      })
    ).toThrow();
  });
});

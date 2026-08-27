import {
  getSupabaseCookieProjectRef,
  validateSupabasePublicEnvironment,
} from '../supabase-config';

describe('Supabase environment validation', () => {
  it('accepts the production self-hosted endpoint', () => {
    expect(
      validateSupabasePublicEnvironment({
        url: 'https://data.helema.cn',
        publishableKey: 'sb_publishable_test',
        expectedHost: 'data.helema.cn',
        nodeEnv: 'production',
      }).url
    ).toBe('https://data.helema.cn');
  });

  it('rejects host drift during production cutover', () => {
    expect(() =>
      validateSupabasePublicEnvironment({
        url: 'https://old-project.supabase.co',
        publishableKey: 'anon-key',
        expectedHost: 'data.helema.cn',
        nodeEnv: 'production',
      })
    ).toThrow('Supabase host mismatch');
  });

  it('requires an explicit production host pin', () => {
    expect(() =>
      validateSupabasePublicEnvironment({
        url: 'https://data.helema.cn',
        publishableKey: 'sb_publishable_test',
        nodeEnv: 'production',
      })
    ).toThrow('WQN_SUPABASE_EXPECTED_HOST');
  });

  it('rejects insecure or local production endpoints', () => {
    expect(() =>
      validateSupabasePublicEnvironment({
        url: 'http://data.helema.cn',
        publishableKey: 'anon-key',
        nodeEnv: 'production',
      })
    ).toThrow('HTTPS');
    expect(() =>
      validateSupabasePublicEnvironment({
        url: 'https://localhost:54321',
        publishableKey: 'anon-key',
        nodeEnv: 'production',
      })
    ).toThrow('localhost');
  });

  it('allows only an explicitly confirmed HTTP Supabase origin', () => {
    expect(
      validateSupabasePublicEnvironment({
        url: 'http://10.77.0.2:8000',
        publishableKey: 'sb_publishable_test',
        expectedHost: '10.77.0.2',
        allowedHttpOrigin: 'http://10.77.0.2:8000',
        nodeEnv: 'production',
      }).url
    ).toBe('http://10.77.0.2:8000');

    for (const allowedHttpOrigin of [
      undefined,
      'http://10.77.0.2:8000/',
      'http://10.77.0.3:8000',
      'https://10.77.0.2:8000',
    ]) {
      expect(() =>
        validateSupabasePublicEnvironment({
          url: 'http://10.77.0.2:8000',
          publishableKey: 'sb_publishable_test',
          expectedHost: '10.77.0.2',
          allowedHttpOrigin,
          nodeEnv: 'production',
        })
      ).toThrow('WQN_ALLOW_HTTP_SUPABASE_ORIGIN');
    }
  });

  it('matches supabase-js cookie refs for hosted and self-hosted URLs', () => {
    expect(getSupabaseCookieProjectRef('https://abc.supabase.co')).toBe('abc');
    expect(getSupabaseCookieProjectRef('https://data.helema.cn')).toBe('data');
  });
});

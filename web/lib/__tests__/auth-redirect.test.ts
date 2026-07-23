import { describe, expect, it } from 'vitest';
import { getSafeAuthRedirect } from '../auth-redirect';
import { buildAuthCallbackUrl } from '../auth-callback';

describe('getSafeAuthRedirect', () => {
  it('falls back to subjects when no redirect is provided', () => {
    expect(getSafeAuthRedirect()).toBe('/subjects');
    expect(getSafeAuthRedirect(null)).toBe('/subjects');
    expect(getSafeAuthRedirect('')).toBe('/subjects');
  });

  it('allows relative app paths', () => {
    expect(getSafeAuthRedirect('/subjects/abc/problems')).toBe(
      '/subjects/abc/problems'
    );
    expect(getSafeAuthRedirect('/problem-sets/123/review?problemId=456')).toBe(
      '/problem-sets/123/review?problemId=456'
    );
  });

  it('rejects external or protocol-relative redirects', () => {
    expect(getSafeAuthRedirect('https://example.com')).toBe('/subjects');
    expect(getSafeAuthRedirect('//example.com')).toBe('/subjects');
    expect(getSafeAuthRedirect('javascript:alert(1)')).toBe('/subjects');
  });
});

describe('buildAuthCallbackUrl', () => {
  it('builds the production callback without leaking tokens', () => {
    expect(buildAuthCallbackUrl('https://wqn.helema.cn', '/subjects')).toBe(
      'https://wqn.helema.cn/auth/callback?next=%2Fsubjects'
    );
  });

  it('sanitises external post-auth redirects', () => {
    expect(
      buildAuthCallbackUrl('https://wqn.helema.cn', 'https://evil.example')
    ).toBe('https://wqn.helema.cn/auth/callback?next=%2Fsubjects');
  });
});

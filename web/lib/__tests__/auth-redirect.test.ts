import { describe, expect, it } from 'vitest';
import { getSafeAuthRedirect } from '../auth-redirect';

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

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_CONSENT_CONSTANTS } from '@/lib/constants';

vi.mock('@/components/cookie-consent/consent-banner', () => ({
  ConsentBanner: () => null,
}));
vi.mock('@/components/cookie-consent/consent-dialog', () => ({
  ConsentDialog: () => null,
}));
import {
  ConsentProvider,
  useConsent,
} from '@/components/cookie-consent/consent-provider';

function consentActions() {
  let context: ReturnType<typeof useConsent> | undefined;
  function Capture() {
    context = useConsent();
    return null;
  }
  renderToStaticMarkup(
    createElement(ConsentProvider, null, createElement(Capture))
  );
  if (!context) throw new Error('Consent context was not provided');
  return context;
}
beforeEach(() => {
  vi.stubGlobal('document', { cookie: '' });
  vi.stubGlobal('window', { location: { protocol: 'https:' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('cookie consent public actions', () => {
  it('requires the provider rather than silently accepting analytics', () => {
    function OutsideProvider() {
      useConsent();
      return null;
    }
    expect(() => renderToStaticMarkup(createElement(OutsideProvider))).toThrow(
      'useConsent must be used within <ConsentProvider>'
    );
  });
  it('starts with no consent during server rendering', () => {
    expect(consentActions().consent).toBeNull();
  });
  it.each([true, false])(
    'persists an explicit analytics preference of %s while keeping essential cookies enabled',
    analytics => {
      consentActions().savePreferences(analytics);
      const value = document.cookie.split(';')[0].split('=')[1];
      expect(JSON.parse(decodeURIComponent(value))).toEqual({
        v: COOKIE_CONSENT_CONSTANTS.CONSENT_VERSION,
        essential: true,
        analytics,
        decidedAt: expect.any(String),
      });
      expect(document.cookie).toContain('SameSite=Lax');
      expect(document.cookie).toContain('Secure');
      expect(document.cookie).toContain(
        `max-age=${COOKIE_CONSENT_CONSTANTS.MAX_AGE_SECONDS}`
      );
    }
  );
  it('rejects optional analytics through rejectAll', () => {
    consentActions().rejectAll();
    expect(decodeURIComponent(document.cookie)).toContain('"analytics":false');
  });
  it('allows optional analytics only after acceptAll', () => {
    consentActions().acceptAll();
    expect(decodeURIComponent(document.cookie)).toContain('"analytics":true');
  });
  it('omits the Secure flag for local HTTP development', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    consentActions().rejectAll();
    expect(document.cookie).not.toContain('Secure');
  });
});

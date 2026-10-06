import { ROUTES } from './constants';

// Control characters (header injection) and backslashes (browsers may treat
// "\" like "/", bypassing the protocol-relative check) are never valid here.
const UNSAFE_REDIRECT_CHARS = /[\u0000-\u001f\\]/;

export function getSafeAuthRedirect(redirectTo?: string | null): string {
  if (!redirectTo) {
    return ROUTES.SUBJECTS;
  }

  if (
    !redirectTo.startsWith('/') ||
    redirectTo.startsWith('//') ||
    UNSAFE_REDIRECT_CHARS.test(redirectTo)
  ) {
    return ROUTES.SUBJECTS;
  }

  return redirectTo;
}

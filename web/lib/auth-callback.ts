import { getSafeAuthRedirect } from './auth-redirect';

export function buildAuthCallbackUrl(
  origin: string,
  redirectTo?: string | null
): string {
  const callback = new URL('/auth/callback', origin);
  callback.searchParams.set('next', getSafeAuthRedirect(redirectTo));
  return callback.toString();
}

import { ROUTES } from './constants';

export function getSafeAuthRedirect(redirectTo?: string | null): string {
  if (!redirectTo) {
    return ROUTES.SUBJECTS;
  }

  if (!redirectTo.startsWith('/') || redirectTo.startsWith('//')) {
    return ROUTES.SUBJECTS;
  }

  return redirectTo;
}

import { cookies } from 'next/headers';
import { routing } from '@/i18n/routing';

/**
 * Locale for pages that live outside the `[locale]` segment.
 *
 * The OAuth consent page sits at a fixed, non-localized path because the
 * authorization endpoint advertised in the RFC 8414 metadata carries no
 * locale prefix. It therefore misses the `[locale]` layout that normally
 * resolves the language, and has to do it itself.
 *
 * The value ends up in a dynamic import path, so it is matched against the
 * fixed locale list rather than taken from the cookie verbatim.
 */
export async function resolveOAuthLocale(): Promise<'en' | 'zh-CN'> {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value;

  const matched = routing.locales.find(locale => locale === cookieLocale);
  return matched ?? routing.defaultLocale;
}

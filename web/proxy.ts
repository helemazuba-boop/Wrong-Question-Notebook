import { createServerClient } from '@supabase/ssr';
import createNextIntlMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import {
  NextResponse,
  NextRequest,
  type NextRequest as NextRequestType,
} from 'next/server';
import { hasEnvVars } from '@/lib/server-utils';
import { getAuthenticatedPrincipal } from '@/lib/supabase/auth-principal';
import { ENV_VARS, USER_ROLES } from '@/lib/constants';

const intlMiddleware = createNextIntlMiddleware(routing);

/** Strip locale prefix from pathname to get the "original" path */
function stripLocaleFromPath(pathname: string): string {
  for (const locale of routing.locales) {
    const prefix = `/${locale}`;
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      const stripped = pathname.slice(prefix.length);
      return stripped || '/';
    }
  }
  return pathname;
}

/** Verify the request identity using the access-token signature. */
async function getUserFromRequest(
  request: NextRequestType,
  cookieUpdater: (cookies: any[]) => void
) {
  if (!hasEnvVars) return { user: null };

  try {
    const supabase = createServerClient(
      process.env[ENV_VARS.SUPABASE_URL]!,
      process.env[ENV_VARS.SUPABASE_ANON_KEY]!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            cookieUpdater(cookiesToSet);
          },
        },
      }
    );
    const { user } = await getAuthenticatedPrincipal(supabase);
    return { user };
  } catch {
    return { user: null };
  }
}

/** Check if user has admin role */
async function checkAdminRole(userId: string) {
  const serverKey =
    process.env[ENV_VARS.SUPABASE_SECRET_KEY] ||
    process.env[ENV_VARS.SUPABASE_SERVICE_ROLE_KEY];
  if (!serverKey) return false;

  try {
    const serviceSupabase = createServerClient(
      process.env[ENV_VARS.SUPABASE_URL]!,
      serverKey,
      {
        cookies: {
          getAll() {
            return [];
          },
          setAll() {
            // No-op for service role
          },
        },
      }
    );

    const { data: profile } = await serviceSupabase
      .from('user_profiles')
      .select('user_role')
      .eq('id', userId)
      .single();

    return (
      profile &&
      [USER_ROLES.ADMIN, USER_ROLES.SUPER_ADMIN].includes(profile.user_role)
    );
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const originalPathname = request.nextUrl.pathname;
  const cookiesToUpdate: any[] = [];

  // Supabase Auth must reach this exact, non-localized callback so it can set
  // the session cookie before the user is redirected into the localized app.
  if (originalPathname === '/auth/callback') {
    return NextResponse.next();
  }

  // RFC 8414 / RFC 9728 discovery documents live at fixed, non-localized
  // paths. They must answer at exactly the URL the client requested: letting
  // them reach intlMiddleware would redirect them under the locale prefix and
  // break the metadata URL advertised in WWW-Authenticate.
  if (originalPathname.startsWith('/.well-known/')) {
    return NextResponse.next();
  }

  // Step 0: API routes should NOT go through intlMiddleware at all
  if (originalPathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Step 1: Handle i18n routing
  //
  // The OAuth consent page lives outside [locale]: the authorization endpoint
  // advertised in the RFC 8414 metadata carries no locale prefix, and clients
  // generally will not follow a redirect to discover it. It resolves its own
  // locale from the NEXT_LOCALE cookie, but still runs the session check
  // below so an unauthenticated user is sent to login first.
  let locale = routing.defaultLocale;
  const skipIntl = originalPathname.startsWith('/oauth/');
  const intlResponse = skipIntl
    ? NextResponse.next()
    : await intlMiddleware(request);

  if (intlResponse.status === 307 || intlResponse.status === 308) {
    return intlResponse;
  }

  // Next-Intl sets this on non-redirect responses
  const finalResponse = intlResponse;

  const localeHeader = intlResponse.headers.get('x-next-intl-locale');
  if (localeHeader && (localeHeader === 'en' || localeHeader === 'zh-CN')) {
    locale = localeHeader;
  } else if (skipIntl) {
    // Without intlMiddleware there is no locale header, so fall back to the
    // cookie next-intl writes when the user switches language.
    const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value;
    if (cookieLocale === 'en' || cookieLocale === 'zh-CN') {
      locale = cookieLocale;
    }
  } else {
    for (const l of routing.locales) {
      if (originalPathname.startsWith(`/${l}`)) {
        locale = l;
        break;
      }
    }
  }

  const contentPath = stripLocaleFromPath(originalPathname);

  // Step 2: Check auth state
  const { user } = await getUserFromRequest(request, cookies => {
    cookiesToUpdate.push(...cookies);
  });

  // Apply collected cookies to any response returned from here on
  const applyCookies = (res: NextResponse) => {
    cookiesToUpdate.forEach(({ name, value, options }) => {
      res.cookies.set(name, value, options);
    });
    return res;
  };

  // Step 3: Handle admin routes
  if (contentPath.startsWith('/admin')) {
    if (!user) {
      return applyCookies(
        NextResponse.redirect(new URL(`/${locale}/auth/login`, request.url))
      );
    }

    const isAdmin = await checkAdminRole(user.id);
    if (!isAdmin) {
      return applyCookies(
        NextResponse.redirect(new URL(`/${locale}/subjects`, request.url))
      );
    }

    return applyCookies(finalResponse);
  }

  // Step 4: Public paths check
  const publicPaths = [
    '/auth',
    '/privacy',
    '/upload',
    '/discover',
    '/creators',
    '/problem-sets/',
  ];
  const apiPublicPaths = [
    '/api/problem-sets',
    '/api/discover',
    '/api/files',
    '/api/problems',
    '/api/qr-upload',
    '/api/internal/problem-marks',
    '/api/cron/generate-digests',
  ];

  const isPublicPath = publicPaths.some(p => contentPath.startsWith(p));
  const isApiPublicPath = apiPublicPaths.some(p => contentPath.startsWith(p));

  if (
    contentPath === '/' ||
    contentPath.startsWith('/auth') ||
    isApiPublicPath ||
    isPublicPath
  ) {
    return applyCookies(finalResponse);
  }

  // Step 5: Protected routes - redirect to login if not authenticated
  if (!user) {
    const loginUrl = new URL(`/${locale}/auth/login`, request.url);
    if (contentPath !== '/') {
      // The query string has to survive the round trip: the OAuth consent
      // page carries client_id, state and the PKCE challenge as query
      // parameters, and dropping them would strand the user at a dead end
      // after they log in.
      loginUrl.searchParams.set(
        'redirect',
        `${contentPath}${request.nextUrl.search}`
      );
    }
    return applyCookies(NextResponse.redirect(loginUrl));
  }

  return applyCookies(finalResponse);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|xml|txt)$).*)',
  ],
};

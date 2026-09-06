import { NextIntlClientProvider } from 'next-intl';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireUser } from '@/lib/supabase/requireUser';
import { clientAllowsRedirectUri, resolveClient } from '@/lib/oauth/clients';
import { parseAuthorizationRequest } from '@/lib/oauth/authorize-request';
import { resolveOAuthLocale } from '@/lib/oauth/locale';
import { ConsentForm } from './consent-form';
import { isKnownAuthorizationError } from './errors';

// OAuth 2.1 consent screen.
//
// Deliberately outside the `[locale]` segment: the authorization endpoint
// advertised in the RFC 8414 metadata carries no locale prefix, and clients
// will not follow a redirect to discover it. The trade-off is that this page
// misses the `[locale]` layout, so it resolves the language and the message
// catalogue itself.

interface AuthorizePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function ConsentShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  // The root layout only provides Common + CookieConsent to client
  // components, so this page has to hand down the full catalogue itself.
  const locale = await resolveOAuthLocale();
  const messages = (await import(`../../../messages/${locale}.json`)).default;

  return (
    <div className="auth-page-bg">
      <main id="main-content" className="auth-page-container">
        <div className="auth-form-wrapper">
          <NextIntlClientProvider locale={locale} messages={messages}>
            <div className="auth-card-amber auth-slide-up">
              <h1 className="auth-title">{title}</h1>
              {children}
            </div>
          </NextIntlClientProvider>
        </div>
      </main>
    </div>
  );
}

export default async function AuthorizePage({
  searchParams,
}: AuthorizePageProps) {
  const params = await searchParams;

  // A previous attempt may have bounced here with a reason.
  const errorParam = Array.isArray(params.error)
    ? params.error[0]
    : params.error;
  const detailParam = Array.isArray(params.detail)
    ? params.detail[0]
    : params.detail;
  if (isKnownAuthorizationError(errorParam)) {
    const t = await getTranslations('OAuthConsent');
    return (
      <ConsentShell title={t('errorTitle')}>
        <p className="auth-subtitle mt-2">
          {t(`errors.${errorParam}`, { default: t('errors.invalid_request') })}
        </p>
        {detailParam ? (
          <p className="form-error mt-3 font-mono text-xs">{detailParam}</p>
        ) : null}
      </ConsentShell>
    );
  }

  const parsed = parseAuthorizationRequest(params);
  if (!parsed.ok) {
    const t = await getTranslations('OAuthConsent');
    return (
      <ConsentShell title={t('errorTitle')}>
        <p className="auth-subtitle mt-2">{t(`errors.${parsed.error}`)}</p>
        {/* The detail names the offending parameter without echoing its
            value, so it is safe to show and still tells the user (or a bug
            report) exactly which rule failed. */}
        <p className="form-error mt-3 font-mono text-xs">{parsed.detail}</p>
      </ConsentShell>
    );
  }
  const request = parsed.request;

  const client = await resolveClient(request.clientId);
  if (!client) {
    const t = await getTranslations('OAuthConsent');
    return (
      <ConsentShell title={t('errorTitle')}>
        <p className="auth-subtitle mt-2">{t('errors.invalid_client')}</p>
      </ConsentShell>
    );
  }

  // The redirect URI is checked before the consent screen is drawn, not only
  // in the action. Both are needed: the action is the real gate (it re-derives
  // everything from the form), but without this check the user is shown a
  // consent screen that is guaranteed to fail on submit -- and the page would
  // render an attacker-supplied callback host while doing it.
  if (!clientAllowsRedirectUri(client, request.redirectUri)) {
    const t = await getTranslations('OAuthConsent');
    return (
      <ConsentShell title={t('errorTitle')}>
        <p className="auth-subtitle mt-2">{t('errors.invalid_redirect_uri')}</p>
      </ConsentShell>
    );
  }

  // proxy.ts normally sends an unauthenticated visitor to login first, but
  // the session is checked here too: a Server Action must never assume the
  // page that rendered it proved anything.
  const { user } = await requireUser();
  if (!user) {
    const returnTo = `/oauth/authorize?${new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      scope: request.scope,
      resource: request.resource,
      ...(request.state ? { state: request.state } : {}),
    }).toString()}`;
    redirect(`/en/auth/login?redirect=${encodeURIComponent(returnTo)}`);
  }

  const t = await getTranslations('OAuthConsent');

  let redirectHost: string;
  try {
    redirectHost = new URL(request.redirectUri).origin;
  } catch {
    // parseAuthorizationRequest already guarantees a syntactically valid
    // value only in the sense that it is non-empty; be defensive anyway.
    redirectHost = request.redirectUri;
  }

  return (
    <ConsentShell title={t('title')}>
      <p className="auth-subtitle mt-2">
        {t('subtitle', { clientName: client.clientName })}
      </p>

      <div className="mt-6 space-y-3">
        <p className="text-sm font-medium text-gray-900 dark:text-white">
          {t('scopeTitle')}
        </p>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <li className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>{t('scopeMcpAll')}</span>
          </li>
        </ul>
      </div>

      <dl className="mt-6 space-y-2 border-t border-amber-200/40 pt-4 text-xs text-gray-600 dark:border-amber-800/30 dark:text-gray-400">
        <div className="flex justify-between gap-4">
          <dt>{t('applicationLabel')}</dt>
          <dd className="truncate font-mono">{client.clientName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{t('redirectLabel')}</dt>
          <dd className="truncate font-mono">{redirectHost}</dd>
        </div>
      </dl>

      <div className="mt-6">
        <ConsentForm
          clientId={request.clientId}
          redirectUri={request.redirectUri}
          state={request.state ?? ''}
          codeChallenge={request.codeChallenge}
          scope={request.scope}
          resource={request.resource}
        />
      </div>

      <p className="mt-4 text-xs text-gray-500 dark:text-gray-500">
        {t('tokenHint')}
      </p>
    </ConsentShell>
  );
}

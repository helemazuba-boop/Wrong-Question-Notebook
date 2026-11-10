import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireUser } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { consumeRateLimit } from '@/lib/rate-limit';
import { normalizeUserCode } from '@/lib/oauth/device';
import { hashOAuthSecret } from '@/lib/oauth/service';
import { resolveOAuthLocale } from '@/lib/oauth/locale';
import { decideDeviceAuthorization } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function DeviceAuthorizationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const locale = await resolveOAuthLocale();
  const t = await getTranslations({ locale, namespace: 'OAuthDevice' });
  const { user } = await requireUser();
  const rawCode = typeof params.user_code === 'string' ? params.user_code : '';
  if (!user) {
    const returnTo = `/oauth/device${rawCode ? `?${new URLSearchParams({ user_code: rawCode })}` : ''}`;
    redirect(`/${locale}/auth/login?redirect=${encodeURIComponent(returnTo)}`);
  }
  const code = normalizeUserCode(rawCode);
  const svc = createServiceClient();
  const allowed =
    !rawCode ||
    consumeRateLimit('oauth-device-lookup', user.id, {
      windowMs: 15 * 60 * 1000,
      maxRequests: 30,
    }).ok;
  const { data: grant } =
    code && allowed
      ? await svc
          .from('oauth_device_authorizations')
          .select('id, client_id, expires_at')
          .eq('user_code_hash', hashOAuthSecret(code))
          .eq('status', 'pending')
          .gt('expires_at', new Date().toISOString())
          .maybeSingle()
      : { data: null };
  const { data: client } = grant
    ? await svc
        .from('oauth_clients')
        .select('client_name')
        .eq('client_id', grant.client_id)
        .maybeSingle()
    : { data: null };
  const requestedResult =
    params.result === 'approved' ||
    params.result === 'denied' ||
    params.result === 'unavailable'
      ? params.result
      : null;
  const resultRequest =
    typeof params.request === 'string' &&
    /^[0-9a-f-]{36}$/i.test(params.request)
      ? params.request
      : null;
  const { data: decided } =
    resultRequest && requestedResult !== 'unavailable'
      ? await svc
          .from('oauth_device_authorizations')
          .select('status')
          .eq('id', resultRequest)
          .eq('user_id', user.id)
          .maybeSingle()
      : { data: null };
  // A user-editable query string cannot attest that consent was granted.
  const result =
    requestedResult === 'unavailable'
      ? 'unavailable'
      : requestedResult === 'approved' &&
          ['approved', 'consumed'].includes(decided?.status ?? '')
        ? 'approved'
        : requestedResult === 'denied' && decided?.status === 'denied'
          ? 'denied'
          : requestedResult
            ? 'unavailable'
            : null;
  return (
    <div className="auth-page-bg">
      <main id="main-content" className="auth-page-container">
        <div className="auth-form-wrapper">
          <div className="auth-card-amber auth-slide-up">
            <h1 className="auth-title">{t('title')}</h1>
            {result ? (
              <p className="auth-subtitle mt-4" role="status">
                {t(result)}
              </p>
            ) : null}
            {grant && client && code && !result ? (
              <form
                action={decideDeviceAuthorization}
                className="mt-6 space-y-5"
              >
                <p className="auth-subtitle">
                  {t('request', { clientName: client.client_name })}
                </p>
                <p className="break-all font-mono text-2xl tracking-widest">
                  {code.slice(0, 4)}-{code.slice(4)}
                </p>
                <p className="text-sm">{t('permissions')}</p>
                <p className="text-sm">{t('duration')}</p>
                <p className="text-sm">
                  {t('account', { account: user.email ?? user.id })}
                </p>
                <input type="hidden" name="authorization_id" value={grant.id} />
                <input type="hidden" name="user_code" value={code} />
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    name="confirmed"
                    value="yes"
                    required
                    className="mt-1"
                  />
                  <span>{t('confirm')}</span>
                </label>
                <div className="flex gap-3">
                  <button
                    type="submit"
                    name="decision"
                    value="approve"
                    className="rounded-lg bg-amber-500 px-5 py-2 font-medium text-gray-950"
                  >
                    {t('approve')}
                  </button>
                  <button
                    type="submit"
                    name="decision"
                    value="deny"
                    formNoValidate
                    className="rounded-lg border px-5 py-2"
                  >
                    {t('deny')}
                  </button>
                </div>
              </form>
            ) : !result ? (
              <form
                action="/oauth/device"
                method="get"
                className="mt-6 space-y-4"
              >
                {rawCode ? (
                  <p className="form-error" role="alert">
                    {t('unavailable')}
                  </p>
                ) : null}
                <label htmlFor="user-code" className="block text-sm">
                  {t('codeLabel')}
                </label>
                <input
                  id="user-code"
                  name="user_code"
                  autoComplete="off"
                  autoCapitalize="characters"
                  maxLength={16}
                  required
                  className="w-full rounded-lg border p-3 font-mono text-gray-950"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-amber-500 px-5 py-2 font-medium text-gray-950"
                >
                  {t('continue')}
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

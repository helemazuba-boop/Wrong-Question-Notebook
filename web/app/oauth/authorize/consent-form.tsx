'use client';

import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { approveAuthorization, denyAuthorization } from './actions';

interface ConsentFormProps {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

/**
 * Allow / Deny.
 *
 * Two separate forms rather than one with a branching action: each button
 * submits to a different Server Action, so the decision never travels as a
 * value the client could tamper with.
 */
export function ConsentForm({
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scope,
  resource,
}: ConsentFormProps) {
  const t = useTranslations('OAuthConsent');

  return (
    <div className="flex flex-col gap-3">
      <form action={approveAuthorization}>
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="client_id" value={clientId} />
        <input type="hidden" name="redirect_uri" value={redirectUri} />
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="resource" value={resource} />
        <Button type="submit" className="btn-cta-primary w-full">
          {t('allow')}
        </Button>
      </form>

      <form action={denyAuthorization}>
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="client_id" value={clientId} />
        <input type="hidden" name="redirect_uri" value={redirectUri} />
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="resource" value={resource} />
        <Button type="submit" variant="outline" className="w-full">
          {t('deny')}
        </Button>
      </form>
    </div>
  );
}

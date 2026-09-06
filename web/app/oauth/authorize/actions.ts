'use server';

import { redirect } from 'next/navigation';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';
import { requireUser } from '@/lib/supabase/requireUser';
import { getAppOrigin } from '@/lib/app-origin';
import { clientAllowsRedirectUri, resolveClient } from '@/lib/oauth/clients';
import { parseAuthorizationRequestFromFormData } from '@/lib/oauth/authorize-request';
import type { AuthorizationRequestError } from '@/lib/oauth/authorize-request';
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  generateAuthorizationCode,
  hashOAuthSecret,
} from '@/lib/oauth/service';
import { OAUTH_AUTHORIZATION_ERRORS } from './errors';

// The consent decision.
//
// Implemented as a Server Action rather than a POST route handler purely for
// CSRF: this endpoint changes state (it mints an authorization code) and is
// authenticated by a session cookie, so a route handler would need hand-rolled
// Origin checking. Next.js verifies the Origin header against the Host for
// Server Actions and rejects a mismatch, so a hostile page cannot drive a
// logged-in user's browser into approving a grant.
//
// Nothing rendered by the page is trusted here: every field is re-parsed and
// re-validated, because the form contents are fully attacker-controllable.

/** Where to send the user when the consent screen cannot be shown at all. */
const CONSENT_UNAVAILABLE_PATH = '/oauth/authorize';

function authorizationErrorRedirect(
  error: AuthorizationRequestError,
  detail: string
): never {
  const query = new URLSearchParams({ error, detail });
  redirect(`${CONSENT_UNAVAILABLE_PATH}?${query.toString()}`);
}

async function buildClientRedirect(
  redirectUri: string,
  params: Record<string, string>
): Promise<string> {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  // RFC 9207: identify the authorization server in the response so a client
  // cannot be tricked into redeeming the code against a mix-up attacker.
  target.searchParams.set('iss', getAppOrigin());
  return target.toString();
}

/**
 * Re-validate the request and, if it holds up, bind the user's consent to a
 * single-use authorization code.
 */
export async function approveAuthorization(formData: FormData): Promise<void> {
  const parsed = parseAuthorizationRequestFromFormData(formData);
  if (!parsed.ok) {
    authorizationErrorRedirect(parsed.error, parsed.detail);
  }
  const request = parsed.request;

  // The session is read inside the action, never inherited from the page.
  const { user } = await requireUser();
  if (!user) {
    const returnTo = `${CONSENT_UNAVAILABLE_PATH}?${new URLSearchParams({
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

  const client = await resolveClient(request.clientId);
  if (!client) {
    authorizationErrorRedirect(
      OAUTH_AUTHORIZATION_ERRORS.invalidClient,
      'unknown_client'
    );
  }
  // Open-redirect guard: without this check an attacker could have the user
  // approve a grant and have the code delivered to their own endpoint.
  if (!clientAllowsRedirectUri(client, request.redirectUri)) {
    authorizationErrorRedirect(
      OAUTH_AUTHORIZATION_ERRORS.invalidRedirectUri,
      'redirect_uri_not_registered'
    );
  }

  const code = generateAuthorizationCode();
  const svc = createServiceClient();
  const { error } = await svc.from('oauth_authorization_codes').insert({
    code_hash: hashOAuthSecret(code),
    client_id: request.clientId,
    user_id: user.id,
    redirect_uri: request.redirectUri,
    scope: request.scope,
    resource: request.resource,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    expires_at: new Date(
      Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000
    ).toISOString(),
  });

  if (error) {
    logger.error('Authorization code issuance failed', error, {
      component: 'OAuthAuthorize',
      action: 'issueCode',
    });
    authorizationErrorRedirect(
      OAUTH_AUTHORIZATION_ERRORS.serverError,
      'code_issuance_failed'
    );
  }

  logger.info('OAuth authorization granted', {
    component: 'OAuthAuthorize',
    action: 'approve',
    userId: user.id,
    clientId: request.clientId,
  });

  const destination = await buildClientRedirect(request.redirectUri, {
    code,
    ...(request.state ? { state: request.state } : {}),
  });
  redirect(destination);
}

/** Deny the grant, reporting access_denied back to the client. */
export async function denyAuthorization(formData: FormData): Promise<void> {
  const parsed = parseAuthorizationRequestFromFormData(formData);
  if (!parsed.ok) {
    authorizationErrorRedirect(parsed.error, parsed.detail);
  }
  const request = parsed.request;

  // The denial redirect is still an outbound redirect driven by client
  // input, so the same registered-URI check applies before honouring it.
  const client = await resolveClient(request.clientId);
  if (!client) {
    authorizationErrorRedirect(
      OAUTH_AUTHORIZATION_ERRORS.invalidClient,
      'unknown_client'
    );
  }
  if (!clientAllowsRedirectUri(client, request.redirectUri)) {
    authorizationErrorRedirect(
      OAUTH_AUTHORIZATION_ERRORS.invalidRedirectUri,
      'redirect_uri_not_registered'
    );
  }

  const destination = await buildClientRedirect(request.redirectUri, {
    error: 'access_denied',
    ...(request.state ? { state: request.state } : {}),
  });
  redirect(destination);
}

import { logger } from '@/lib/logger';
import { getMcpResourceUri, normalizeCodeChallenge } from './service';

// Parsing and validation of an OAuth 2.1 authorization request.
//
// Shared by the consent page and the server action that issues the code,
// because the action must not trust anything the page rendered: everything
// that comes back through the form is re-validated from scratch.

export type AuthorizationRequestError =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'invalid_redirect_uri'
  // Not produced while parsing the request itself, but raised by the consent
  // action once it looks the client up. Sharing one union keeps the error
  // page's translation lookup total.
  | 'invalid_client'
  | 'server_error';

/**
 * Machine-readable reason a request was refused.
 *
 * Every rejection carries one so the consent screen can say *which* parameter
 * failed -- a bare "malformed request" is undebuggable in production, and the
 * authorization request has more parameters than any other OAuth message.
 * These name the parameter and the rule, never its value: a code_challenge or
 * state must not end up in a log or a rendered page.
 */
export type AuthorizationRequestDetail =
  | 'response_type_not_code'
  | 'missing_client_id'
  | 'client_id_too_long'
  | 'missing_redirect_uri'
  | 'missing_code_challenge_method'
  | 'code_challenge_method_not_s256'
  | 'missing_code_challenge'
  | 'malformed_code_challenge'
  | 'state_too_long'
  | 'unsupported_scope'
  | 'unknown_resource'
  // Raised by the consent action rather than the parser.
  | 'unknown_client'
  | 'redirect_uri_not_registered'
  | 'code_issuance_failed';

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string;
}

export type AuthorizationRequestResult =
  | { ok: true; request: AuthorizationRequest }
  | {
      ok: false;
      error: AuthorizationRequestError;
      detail: AuthorizationRequestDetail;
    };

const MAX_CLIENT_ID_LENGTH = 2048;
/**
 * `state` is opaque to the authorization server: RFC 6749 has the client set
 * it and the server echo it back verbatim. Nothing here parses or stores it,
 * so the only real constraint is that it has to survive being round-tripped
 * through a redirect URL -- which browsers and HTTP servers handle up to
 * several kilobytes.
 *
 * The cap exists only to bound a hostile request, and deliberately sits well
 * above anything a client reasonably sends. Real clients have been seen
 * shipping JSON or JWT blobs well past 1 KB; an earlier 512-character cap
 * broke them.
 */
const MAX_STATE_LENGTH = 4096;

function invalid(
  detail: AuthorizationRequestDetail,
  context: Record<string, unknown> = {},
  error: AuthorizationRequestError = 'invalid_request'
): AuthorizationRequestResult {
  logger.warn('OAuth authorization request rejected', {
    component: 'OAuthAuthorize',
    action: 'parseRequest',
    error,
    detail,
    ...context,
  });
  return { ok: false, error, detail };
}

export function parseAuthorizationRequest(
  params: Record<string, string | string[] | null | undefined>
): AuthorizationRequestResult {
  const first = (
    value: string | string[] | null | undefined
  ): string | null => {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };

  const responseType = first(params.response_type);
  // Only the authorization code flow is implemented; `token` (implicit) was
  // removed in OAuth 2.1 and must not be silently accepted.
  if (responseType !== 'code') {
    logger.warn('OAuth authorization request rejected', {
      component: 'OAuthAuthorize',
      action: 'parseRequest',
      error: 'unsupported_response_type',
      detail: 'response_type_not_code',
    });
    return {
      ok: false,
      error: 'unsupported_response_type',
      detail: 'response_type_not_code',
    };
  }

  const clientId = first(params.client_id);
  const redirectUri = first(params.redirect_uri);
  const codeChallenge = first(params.code_challenge);
  const codeChallengeMethod = first(params.code_challenge_method);

  if (!clientId) return invalid('missing_client_id');
  if (clientId.length > MAX_CLIENT_ID_LENGTH) {
    return invalid('client_id_too_long');
  }
  if (!redirectUri) return invalid('missing_redirect_uri');

  // PKCE is mandatory and S256-only: `plain` offers no protection against a
  // code intercepted on the redirect, which is the entire point of PKCE. The
  // comparison is case-insensitive because RFC 7636 registers the value as
  // case-insensitive and clients do send `s256`.
  if (!codeChallengeMethod) return invalid('missing_code_challenge_method');
  if (codeChallengeMethod.toUpperCase() !== 'S256') {
    return invalid('code_challenge_method_not_s256');
  }

  // Normalised to bare base64url and stored in that form, so the token
  // endpoint's plain comparison against SHA256(verifier) always lines up even
  // for a client that padded the challenge or used the base64 alphabet.
  if (!codeChallenge) return invalid('missing_code_challenge');
  const canonicalChallenge = normalizeCodeChallenge(codeChallenge);
  if (!canonicalChallenge) return invalid('malformed_code_challenge');

  const rawState = first(params.state);
  if (rawState !== null && rawState.length > MAX_STATE_LENGTH) {
    // The observed length is logged (never the value) because the cap is a
    // guess at what clients need: if this ever fires, the number says whether
    // the client is merely large or genuinely abusive.
    return invalid('state_too_long', { stateLength: rawState.length });
  }

  const scope = first(params.scope);
  if (scope !== null && scope !== 'mcp:all') {
    return { ok: false, error: 'invalid_scope', detail: 'unsupported_scope' };
  }

  const resource = first(params.resource);
  if (resource !== null && resource !== getMcpResourceUri()) {
    return { ok: false, error: 'invalid_target', detail: 'unknown_resource' };
  }

  return {
    ok: true,
    request: {
      clientId,
      redirectUri,
      state: rawState,
      codeChallenge: canonicalChallenge,
      scope: scope ?? 'mcp:all',
      resource: resource ?? getMcpResourceUri(),
    },
  };
}

/** Read the authorization request out of a submitted form. */
export function parseAuthorizationRequestFromFormData(
  formData: FormData
): AuthorizationRequestResult {
  const read = (key: string): string | undefined => {
    const value = formData.get(key);
    return typeof value === 'string' ? value : undefined;
  };

  return parseAuthorizationRequest({
    response_type: read('response_type'),
    client_id: read('client_id'),
    redirect_uri: read('redirect_uri'),
    state: read('state') ?? null,
    code_challenge: read('code_challenge'),
    code_challenge_method: read('code_challenge_method'),
    scope: read('scope'),
    resource: read('resource'),
  });
}

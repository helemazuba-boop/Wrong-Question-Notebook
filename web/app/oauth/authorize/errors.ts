// Stable identifiers for the consent-page error state.
//
// These are the values echoed into the `error` query parameter when the
// authorization request cannot be honoured. They are deliberately the OAuth
// error codes plus a couple of local ones, so the page can look them up in the
// translation catalogue without mapping between two vocabularies.

export const OAUTH_AUTHORIZATION_ERRORS = {
  invalidRequest: 'invalid_request',
  unauthorizedClient: 'unauthorized_client',
  unsupportedResponseType: 'unsupported_response_type',
  invalidScope: 'invalid_scope',
  invalidTarget: 'invalid_target',
  invalidRedirectUri: 'invalid_redirect_uri',
  invalidClient: 'invalid_client',
  serverError: 'server_error',
} as const;

export type OAuthAuthorizationError =
  (typeof OAUTH_AUTHORIZATION_ERRORS)[keyof typeof OAUTH_AUTHORIZATION_ERRORS];

export function isKnownAuthorizationError(
  value: string | undefined
): value is OAuthAuthorizationError {
  return (
    value !== undefined &&
    Object.values(OAUTH_AUTHORIZATION_ERRORS).includes(
      value as OAuthAuthorizationError
    )
  );
}

import 'server-only';

// Canonical external origin of this deployment.
//
// Shared by the MCP route (confirmation URLs) and the OAuth metadata endpoints
// (RFC 9728 / RFC 8414). Discovery only works if every advertised URL is
// byte-identical to what the client is actually talking to, so there is
// exactly one resolver and it fails loudly in production when unconfigured.

export function getAppOrigin(): string {
  const configuredOrigin =
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`
      : '');

  if (!configuredOrigin) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SITE_URL or NEXT_PUBLIC_APP_URL must be configured');
    }
    return 'http://localhost:3000';
  }

  const url = new URL(configuredOrigin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Configured application URL must use HTTP or HTTPS');
  }
  return url.origin;
}

/**
 * Content-Security-Policy shared by HTML pages (next.config.ts headers)
 * and API routes (SECURITY_HEADERS, applied by lib/security-middleware.ts).
 *
 * V1 keeps 'unsafe-inline'/'unsafe-eval' because the Next.js runtime relies
 * on inline scripts; tightening this to nonces is a separate follow-up.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://data.helema.cn wss://data.helema.cn https://*.supabase.co https://*.supabase.in; frame-ancestors 'none'; base-uri 'self'; form-action 'self';";

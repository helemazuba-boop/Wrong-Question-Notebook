/**
 * Content-Security-Policy shared by HTML pages (next.config.ts headers)
 * and API routes (SECURITY_HEADERS, applied by lib/security-middleware.ts).
 *
 * V1 keeps 'unsafe-inline'/'unsafe-eval' because the Next.js runtime relies
 * on inline scripts; tightening this to nonces is a separate follow-up.
 */
import {
  validateSupabasePublicEnvironment,
  type SupabaseEnvironmentInput,
} from './supabase-config';

export function buildContentSecurityPolicy(
  input?: SupabaseEnvironmentInput
): string {
  const connectSources = new Set([
    "'self'",
    'https://data.helema.cn',
    'wss://data.helema.cn',
    'https://*.supabase.co',
    'https://*.supabase.in',
  ]);
  if (input?.url) {
    const { url } = validateSupabasePublicEnvironment(input);
    connectSources.add(url);
    connectSources.add(url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:'));
  }
  return `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src ${[...connectSources].join(' ')}; frame-ancestors 'none'; base-uri 'self'; form-action 'self';`;
}

export const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY,
  expectedHost: process.env.WQN_SUPABASE_EXPECTED_HOST,
  allowedHttpOrigin: process.env.WQN_ALLOW_HTTP_SUPABASE_ORIGIN,
  nodeEnv: process.env.NODE_ENV,
});

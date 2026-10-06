import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import * as path from 'node:path';
import { validateSupabasePublicEnvironment } from './lib/supabase-config';
import { CONTENT_SECURITY_POLICY } from './lib/security-policy';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');
const projectRoot = path.resolve(__dirname);

const supabaseEnvironment =
  process.env.NODE_ENV === 'production'
    ? validateSupabasePublicEnvironment({
        url: process.env.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey:
          process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY,
        expectedHost: process.env.WQN_SUPABASE_EXPECTED_HOST,
        allowedHttpOrigin: process.env.WQN_ALLOW_HTTP_SUPABASE_ORIGIN,
        nodeEnv: process.env.NODE_ENV,
      })
    : null;

const supabaseImageUrl = new URL(
  supabaseEnvironment?.url ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    'https://data.helema.cn'
);
const supabaseImageProtocol = supabaseImageUrl.protocol.slice(0, -1) as
  'http' | 'https';

/**
 * Hosts allowed to invoke Server Actions.
 *
 * Next.js compares the `Origin` header against `x-forwarded-host` (falling
 * back to `host`). A reverse proxy that forwards its own upstream address --
 * `proxy_set_header X-Forwarded-Host $proxy_host` yields `127.0.0.1` -- makes
 * every Server Action look cross-origin, and Next aborts it with
 * "Invalid Server Actions request". Listing the public host here keeps the
 * check meaningful (a foreign origin is still rejected) instead of disabling
 * it, which is the documented remedy for a proxied deployment.
 *
 * The proxy should still be corrected to forward `$host`; this is a safety
 * net so a proxy misconfiguration cannot take the consent screen down.
 */
function serverActionAllowedOrigins(): string[] {
  const origin =
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`
      : '');

  if (!origin) return [];

  try {
    return [new URL(origin).host];
  } catch {
    // next.config.ts runs at build and server start; a bad SITE_URL must not
    // stop the app from booting.
    return [];
  }
}

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployment
  output: 'standalone',

  // Do not advertise the framework in responses.
  poweredByHeader: false,

  // Keep Turbopack scoped to the app package even when the repo root also has a lockfile.
  turbopack: {
    root: projectRoot,
  },

  // Allow the dev client to load HMR resources when accessed through the local bridge host.
  allowedDevOrigins: ['172.21.128.1'],

  // Enable experimental features for better performance
  experimental: {
    optimizePackageImports: ['lucide-react'],
    serverActions: {
      allowedOrigins: serverActionAllowedOrigins(),
    },
  },

  // Image optimization
  images: {
    formats: ['image/webp', 'image/avif'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    remotePatterns: [
      {
        protocol: supabaseImageProtocol,
        hostname: supabaseImageUrl.hostname,
        port: supabaseImageUrl.port,
        pathname: '/storage/v1/object/public/avatars/**',
      },
      // Temporary rollback compatibility until all avatar objects and URLs
      // have been verified on data.helema.cn.
      {
        protocol: 'https',
        hostname: 'vilwgffpmhkmhecdjbcg.supabase.co',
        pathname: '/storage/v1/object/public/avatars/**',
      },
    ],
  },

  // Security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
      {
        // HTML pages only. API routes already receive the same policy from
        // withSecurity (lib/security-middleware.ts), so excluding them here
        // avoids a duplicate header.
        source: '/((?!api|_next/static|_next/image).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: CONTENT_SECURITY_POLICY,
          },
        ],
      },
    ];
  },

  // Redirects for better SEO
  async redirects() {
    return [
      {
        source: '/home',
        destination: '/',
        permanent: true,
      },
    ];
  },

  // Ensure proper output for Vercel
  trailingSlash: false,
};

export default withNextIntl(nextConfig);

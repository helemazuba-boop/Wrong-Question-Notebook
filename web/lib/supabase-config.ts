export interface SupabasePublicEnvironment {
  url: string;
  publishableKey: string;
}

export interface SupabaseEnvironmentInput {
  url?: string;
  publishableKey?: string;
  expectedHost?: string;
  nodeEnv?: string;
}

export function validateSupabasePublicEnvironment(
  input: SupabaseEnvironmentInput
): SupabasePublicEnvironment {
  if (!input.url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  if (!input.publishableKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY is not set');
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be a valid URL');
  }

  if (input.nodeEnv === 'production') {
    if (url.protocol !== 'https:') {
      throw new Error('Production Supabase URL must use HTTPS');
    }
    if (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1'
    ) {
      throw new Error('Production Supabase URL must not use localhost');
    }
    if (!input.expectedHost) {
      throw new Error('WQN_SUPABASE_EXPECTED_HOST is required in production');
    }
  }

  if (input.expectedHost && url.hostname !== input.expectedHost) {
    throw new Error(
      `Supabase host mismatch: expected ${input.expectedHost}, received ${url.hostname}`
    );
  }

  return {
    url: url.origin,
    publishableKey: input.publishableKey,
  };
}

/** Mirrors the storage key derivation used by @supabase/supabase-js. */
export function getSupabaseCookieProjectRef(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

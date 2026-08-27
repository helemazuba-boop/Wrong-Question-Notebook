import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthenticatedPrincipal {
  id: string;
  email: string | null;
}

/**
 * Verify the access-token signature and expose the small, stable identity
 * surface used by application routes. With asymmetric signing keys this uses
 * the SDK's cached JWKS and avoids a per-request GoTrue user lookup.
 */
export async function getAuthenticatedPrincipal(
  supabase: SupabaseClient<any>
): Promise<{
  user: AuthenticatedPrincipal | null;
  error: Error | null;
}> {
  const { data, error } = await supabase.auth.getClaims();
  const subject = data?.claims?.sub;
  if (error || typeof subject !== 'string' || !subject) {
    return {
      user: null,
      error: error ?? new Error('Unauthorised'),
    };
  }

  return {
    user: {
      id: subject,
      email: typeof data.claims.email === 'string' ? data.claims.email : null,
    },
    error: null,
  };
}

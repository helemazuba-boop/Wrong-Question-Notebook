import type { SupabaseClient } from '@supabase/supabase-js';

export class AccountStatusUnavailable extends Error {
  constructor() {
    super('Account status is unavailable');
  }
}

// Check the current database state, not a role/status cached in a signed JWT.
// Service-backed credential endpoints must enforce this before doing work too.
export async function accountIsActive(
  client: SupabaseClient<any>,
  userId: string
): Promise<boolean> {
  const { data, error } = await client
    .from('user_profiles')
    .select('is_active')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new AccountStatusUnavailable();
  return data?.is_active === true;
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

type UserProfilePatch = Partial<
  Database['public']['Tables']['user_profiles']['Insert']
>;

/**
 * Insert-or-update a user_profiles row without tripping the NOT NULL
 * username constraint. A blind upsert broke both ways: the first-ever write
 * from a profile PATCH or an avatar upload has no username (23502 on the
 * INSERT branch), and including one would overwrite the existing username on
 * the UPDATE branch. So: update when the row exists, otherwise insert with a
 * deterministic fallback username (unique because the uid prefix is).
 */
export async function upsertUserProfileRow(
  service: SupabaseClient<Database>,
  userId: string,
  patch: UserProfilePatch
) {
  const { data: existing, error: readError } = await service
    .from('user_profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (readError) {
    return { data: null, error: readError };
  }

  if (existing) {
    return service
      .from('user_profiles')
      .update(patch as never)
      .eq('id', userId)
      .select()
      .maybeSingle();
  }

  const fallbackUsername = `user_${userId.replace(/-/g, '').slice(0, 12)}`;
  const insertRow = {
    id: userId,
    username: fallbackUsername,
    ...patch,
  } as Database['public']['Tables']['user_profiles']['Insert'];
  const inserted = await service
    .from('user_profiles')
    .insert(insertRow)
    .select()
    .maybeSingle();
  if (inserted.error?.code === '23505') {
    // Lost a first-write race (or the fallback username collided): the row
    // exists now, retry as a plain update.
    return service
      .from('user_profiles')
      .update(patch as never)
      .eq('id', userId)
      .select()
      .maybeSingle();
  }
  return inserted;
}

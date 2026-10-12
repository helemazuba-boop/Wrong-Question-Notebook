import { createClient } from '@supabase/supabase-js';

const userId = process.argv[2];
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId ?? '')) {
  throw new Error(
    'Usage: node scripts/bootstrap-super-admin.mjs <existing-active-user-uuid>'
  );
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key)
  throw new Error('Supply the Supabase URL and a server service credential');
const client = createClient(url, key, { auth: { persistSession: false } });
const { error } = await client.rpc('bootstrap_super_admin', {
  p_user_id: userId,
});
if (error) throw new Error(error.message);
console.log('Initial super administrator configured');

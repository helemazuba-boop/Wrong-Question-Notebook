export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { getSupabaseServerEnvironment } =
    await import('./lib/supabase-server-config');
  getSupabaseServerEnvironment();
}

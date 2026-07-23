function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const publicUrl = new URL(required('NEXT_PUBLIC_SUPABASE_URL'));
if (publicUrl.protocol !== 'https:') {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL must use HTTPS');
}
const expectedHost = process.env.WQN_SUPABASE_EXPECTED_HOST?.trim();
if (expectedHost && publicUrl.hostname !== expectedHost) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL does not match the expected host');
}
const publicKey = required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY');
const serverKey =
  process.env.SUPABASE_SECRET_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!serverKey) {
  throw new Error(
    'SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY must be set'
  );
}
if (serverKey === publicKey) {
  throw new Error('Supabase server key must differ from the publishable key');
}

await import('./server.js');

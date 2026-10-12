import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { accountIsActive } from '@/lib/supabase/account-status';
import { AccountDataClient } from '@/components/account-data-client';
export default async function AccountPage() {
  const client = await createClient();
  const { data, error } = await client.auth.getClaims();
  if (error || typeof data?.claims?.sub !== 'string')
    redirect('/auth/login?redirect=/account');
  return (
    <AccountDataClient
      email={typeof data.claims.email === 'string' ? data.claims.email : ''}
      active={await accountIsActive(client, data.claims.sub)}
    />
  );
}

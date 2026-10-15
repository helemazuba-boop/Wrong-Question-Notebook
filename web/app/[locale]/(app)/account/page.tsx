import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { accountIsActive } from '@/lib/supabase/account-status';
import { AccountDataClient } from '@/components/account-data-client';
import { getVerifiedPrincipal } from '@/lib/supabase/auth-principal';
export default async function AccountPage() {
  const client = await createClient();
  const { user } = await getVerifiedPrincipal(client);
  if (!user) redirect('/auth/login?redirect=/account');
  return (
    <AccountDataClient
      email={user.email ?? ''}
      active={await accountIsActive(client, user.id)}
    />
  );
}

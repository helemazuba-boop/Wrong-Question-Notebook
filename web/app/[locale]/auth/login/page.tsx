import { LoginForm } from '@/components/login-form';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getSafeAuthRedirect } from '@/lib/auth-redirect';
import { getVerifiedPrincipal } from '@/lib/supabase/auth-principal';
import { accountIsActive } from '@/lib/supabase/account-status';

interface PageProps {
  searchParams: Promise<{ redirect?: string; reauth?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const { user } = await getVerifiedPrincipal(supabase);
  const { redirect: redirectParam, reauth } = await searchParams;

  if (user && reauth !== '1') {
    redirect(
      (await accountIsActive(supabase, user.id))
        ? getSafeAuthRedirect(redirectParam)
        : '/account'
    );
  }

  return (
    <div className="auth-page-container">
      <div className="auth-form-wrapper">
        <LoginForm redirectTo={redirectParam} />
      </div>
    </div>
  );
}

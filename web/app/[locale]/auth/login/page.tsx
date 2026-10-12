import { LoginForm } from '@/components/login-form';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getSafeAuthRedirect } from '@/lib/auth-redirect';

interface PageProps {
  searchParams: Promise<{ redirect?: string; reauth?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const { redirect: redirectParam, reauth } = await searchParams;

  if (data?.claims && reauth !== '1') {
    redirect(getSafeAuthRedirect(redirectParam));
  }

  return (
    <div className="auth-page-container">
      <div className="auth-form-wrapper">
        <LoginForm redirectTo={redirectParam} />
      </div>
    </div>
  );
}

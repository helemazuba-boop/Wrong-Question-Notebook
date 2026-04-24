'use client';

import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { useRouter } from '@/i18n/navigation';
import { useState } from 'react';
import { ROUTES, ERROR_MESSAGES } from '@/lib/constants';
import { LogIn, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface LoginFormProps extends React.ComponentPropsWithoutRef<'div'> {
  redirectTo?: string;
}

export function LoginForm({ className, redirectTo, ...props }: LoginFormProps) {
  const t = useTranslations('Auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const supabase = createClient();
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      const destination = redirectTo || ROUTES.SUBJECTS;
      router.push(destination);
    } catch (error: unknown) {
      setError(
        error instanceof Error ? error.message : ERROR_MESSAGES.INTERNAL_ERROR
      );
      setIsLoading(false);
    }
  };

  return (
    <div className={cn('w-full auth-fade-in', className)} {...props}>
      <div className="auth-card-amber">
        {/* Icon header */}
        <div className="flex justify-center mb-6 auth-icon-entrance">
          <div className="auth-icon-box-amber">
            <LogIn className="w-6 h-6 text-amber-600 dark:text-amber-400" />
          </div>
        </div>

        {/* Title */}
        <div className="text-center mb-6 space-y-2">
          <h1 className="auth-title">{t('welcomeBack')}</h1>
          <p className="auth-subtitle">{t('enterCredentials')}</p>
        </div>

        {/* Form */}
        <form onSubmit={handleLogin} className="auth-slide-up space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t('email')}</Label>
            <Input
              id="email"
              type="email"
              placeholder={t('emailPlaceholder')}
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t('password')}</Label>
              <Link
                href="/auth/forgot-password"
                className="auth-link text-sm underline"
              >
                {t('forgotPassword')}
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(prev => !prev)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={
                  showPassword ? t('hidePassword') : t('showPassword')
                }
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <Button
            type="submit"
            className="w-full btn-cta-primary"
            disabled={isLoading}
          >
            {isLoading ? t('loggingIn') : t('login')}
          </Button>
        </form>

        {/* Links */}
        <div className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
          {t('dontHaveAccount')}{' '}
          <Link href="/auth/sign-up" className="auth-link underline">
            {t('signUp')}
          </Link>
        </div>
      </div>
    </div>
  );
}

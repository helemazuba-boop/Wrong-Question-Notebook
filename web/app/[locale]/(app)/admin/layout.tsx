import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { isCurrentUserSuperAdmin } from '@/lib/user-management';
import { AdminLayoutShell } from '@/components/admin/admin-layout-shell';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata');
  return { title: t('adminMetaTitle') };
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, error: authError } = await requireUser();
  if (authError || !user) {
    redirect(ROUTES.AUTH.LOGIN);
  }

  const isSuperAdmin = await isCurrentUserSuperAdmin();
  if (!isSuperAdmin) {
    redirect(ROUTES.SUBJECTS);
  }

  return <AdminLayoutShell>{children}</AdminLayoutShell>;
}

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { isCurrentUserModerator, getUserProfile } from '@/lib/user-management';
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

  const canManage = await isCurrentUserModerator();
  if (!canManage) {
    redirect(ROUTES.SUBJECTS);
  }

  const profile = await getUserProfile(user.id);
  return (
    <AdminLayoutShell role={profile?.user_role ?? 'user'}>
      {children}
    </AdminLayoutShell>
  );
}

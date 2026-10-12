import { isCurrentUserSuperAdmin } from '@/lib/user-management';
import { notFound } from 'next/navigation';
import { getAdminSettings } from '@/lib/user-management';
import { SettingsPageClient } from '@/components/admin/settings/settings-page-client';

export default async function AdminSettingsPage() {
  if (!(await isCurrentUserSuperAdmin())) notFound();
  const settings = await getAdminSettings();

  return <SettingsPageClient settings={settings} />;
}

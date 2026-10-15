import { isCurrentUserSuperAdmin } from '@/lib/user-management';
import { notFound } from 'next/navigation';
import { getAnnouncement } from '@/lib/user-management';
import { AnnouncementEditor } from '@/components/admin/announcements/announcement-editor';

export default async function AdminAnnouncementsPage() {
  if (!(await isCurrentUserSuperAdmin())) notFound();
  const announcement = await getAnnouncement();

  return <AnnouncementEditor initial={announcement} />;
}

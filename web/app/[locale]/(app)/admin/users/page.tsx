import { isCurrentUserAdmin } from '@/lib/user-management';
import { notFound } from 'next/navigation';
import { getAllUsersWithCount } from '@/lib/user-management';
import { UsersPageClient } from '@/components/admin/users/users-page-client';

export default async function AdminUsersPage() {
  if (!(await isCurrentUserAdmin())) notFound();
  const { users, total_count } = await getAllUsersWithCount(20, 0);

  return (
    <UsersPageClient initialUsers={users} initialTotalCount={total_count} />
  );
}

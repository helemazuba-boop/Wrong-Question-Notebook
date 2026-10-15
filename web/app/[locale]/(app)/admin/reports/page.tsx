import { notFound } from 'next/navigation';
import { isCurrentUserModerator } from '@/lib/user-management';
import { createServiceClient } from '@/lib/supabase-utils';
import { listModerationReports } from '@/lib/moderation';
import { ReportsQueueClient } from '@/components/admin/reports-queue-client';

export default async function ReportsPage() {
  if (!(await isCurrentUserModerator())) notFound();
  const reports = await listModerationReports(
    createServiceClient(),
    'pending',
    0
  );
  return <ReportsQueueClient initialReports={reports} />;
}

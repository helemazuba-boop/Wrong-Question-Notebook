import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { withSecurity } from '@/lib/security-middleware';
import { isValidUuid } from '@/lib/common-utils';
async function download(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  const { id } = await params;
  if (!isValidUuid(id))
    return NextResponse.json({ error: 'Invalid export' }, { status: 400 });
  const client = createServiceClient();
  const { data: job, error } = await (client as any)
    .from('account_data_jobs')
    .select('archive_path,expires_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('kind', 'export')
    .eq('status', 'completed')
    .maybeSingle();
  if (error)
    return NextResponse.json({ error: 'Export unavailable' }, { status: 503 });
  if (!job?.archive_path || Date.parse(job.expires_at) <= Date.now())
    return NextResponse.json(
      { error: 'Export not found or expired' },
      { status: 404 }
    );
  const signed = await client.storage
    .from('account-exports')
    .createSignedUrl(job.archive_path, 60, { download: 'wqn-account.tar.gz' });
  return signed.error
    ? NextResponse.json({ error: 'Download unavailable' }, { status: 503 })
    : NextResponse.json(
        { url: signed.data.signedUrl },
        { headers: { 'Cache-Control': 'no-store' } }
      );
}
export const GET = withSecurity(download, { rateLimitType: 'readOnly' });

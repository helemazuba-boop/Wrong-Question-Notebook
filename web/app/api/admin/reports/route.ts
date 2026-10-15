import { NextResponse } from 'next/server';
import { isCurrentUserModerator } from '@/lib/user-management';
import { createServiceClient } from '@/lib/supabase-utils';
import { listModerationReports } from '@/lib/moderation';
import { withSecurity } from '@/lib/security-middleware';

async function list(req: Request) {
  if (!(await isCurrentUserModerator()))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const search = new URL(req.url).searchParams;
  const status = search.get('status') ?? 'pending';
  const offset = Number(search.get('offset') ?? 0);
  if (
    !['pending', 'reviewed', 'dismissed', 'all'].includes(status) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  ) {
    return NextResponse.json(
      { error: 'Invalid report query' },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json({
      reports: await listModerationReports(
        createServiceClient(),
        status,
        offset
      ),
    });
  } catch {
    return NextResponse.json(
      { error: 'Report queue is unavailable' },
      { status: 503 }
    );
  }
}
export const GET = withSecurity(list, { rateLimitType: 'api' });

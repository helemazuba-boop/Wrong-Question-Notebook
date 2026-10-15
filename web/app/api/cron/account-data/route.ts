import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  cleanupExpiredAccountExports,
  processAccountDataJobs,
} from '@/lib/account-data';
import { logger } from '@/lib/logger';
export const maxDuration = 300;
export async function GET(req: Request) {
  if (
    !process.env.CRON_SECRET ||
    req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const client = createServiceClient();
    await cleanupExpiredAccountExports(client);
    return NextResponse.json(await processAccountDataJobs(client));
  } catch (error) {
    logger.error('Account data worker failed', error, {
      component: 'AccountData',
    });
    return NextResponse.json(
      { error: 'Account data worker unavailable' },
      { status: 503 }
    );
  }
}

import { NextResponse } from 'next/server';
import { runProjectionBatch } from '@/lib/fsrs/projector';

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    req.headers.get('authorization') !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runProjectionBatch({
      limit: 20,
      leaseSeconds: 180,
      concurrency: 3,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Problem Review projection failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

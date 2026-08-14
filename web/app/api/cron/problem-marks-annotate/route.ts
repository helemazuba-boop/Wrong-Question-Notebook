import { NextResponse } from 'next/server';
import { runProblemMarkAnnotationBatch } from '@/lib/problem-marks/worker';

// Bounded cron drain for the durable Problem Mark annotation queue. Claim size,
// concurrency, lease duration, and the wall-clock deadline are all capped; the
// best-effort after() wake handles promptness, this route is the backstop.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    req.headers.get('authorization') !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runProblemMarkAnnotationBatch({
      limit: 20,
      leaseSeconds: 180,
      concurrency: 2,
      deadlineMs: 240_000,
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Problem Mark annotation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { runProblemMarkAnnotationBatch } from '@/lib/problem-marks/worker';

// Bounded cron drain for the durable Problem Mark annotation queue. Claim size,
// concurrency, lease duration, and the wall-clock deadline are all capped; the
// best-effort after() wake handles promptness, this route is the backstop.
export const runtime = 'nodejs';
// The bounded batch declares a 240s wall-clock deadline; without this hint the
// platform default truncates the drain before a chunk can finish. Self-hosted
// 'next start' ignores it.
export const maxDuration = 300;

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

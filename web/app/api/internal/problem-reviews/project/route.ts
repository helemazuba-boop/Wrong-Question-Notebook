import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runProjectionBatch } from '@/lib/fsrs/projector';
import { verifyInternalRequest } from '@/lib/internal-request-auth';

const bodySchema = z
  .object({
    max_jobs: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export async function POST(req: Request) {
  const bodyText = await req.text();
  const secret = process.env.PROBLEM_REVIEW_PROJECTION_SECRET;
  if (
    !secret ||
    !verifyInternalRequest({
      secret,
      timestamp: req.headers.get('x-wqn-timestamp'),
      signature: req.headers.get('x-wqn-signature'),
      body: bodyText,
    })
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(JSON.parse(bodyText));
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  try {
    const result = await runProjectionBatch({
      limit: input.max_jobs,
      leaseSeconds: 120,
      concurrency: 1,
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Problem Review projection failed',
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { annotateProblemMarks } from '@/lib/problem-marks/annotate';
import { createServiceClient } from '@/lib/supabase-utils';
import { verifyInternalRequest } from '@/lib/internal-request-auth';

const bodySchema = z.object({ problem_id: z.uuid() }).strict();

export async function POST(req: Request) {
  const bodyText = await req.text();
  const secret = process.env.PROBLEM_MARKING_SECRET;
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
    const result = await annotateProblemMarks(
      createServiceClient(),
      input.problem_id
    );
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Problem Mark annotation failed',
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { verifyInternalRequest } from '@/lib/internal-request-auth';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  applyWordSchedulerAuthorityAction,
  WordSchedulerAuthorityActionSchema,
  WordSchedulerAuthorityControlError,
} from '@/lib/word-scheduler-authority-control';

// Same HMAC secret as the problem-side cutover endpoint: both are equally
// privileged operator actions and one secret means one value to rotate.
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

  let input;
  try {
    input = WordSchedulerAuthorityActionSchema.parse(JSON.parse(bodyText));
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  try {
    const result = await applyWordSchedulerAuthorityAction(
      createServiceClient(),
      input
    );
    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof WordSchedulerAuthorityControlError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: 'WORD_SCHEDULER_AUTHORITY_CONTROL_FAILED' },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import {
  applyFsrsAuthorityAction,
  FsrsAuthorityActionSchema,
  FsrsAuthorityControlError,
} from '@/lib/fsrs/authority-control';
import { verifyInternalRequest } from '@/lib/internal-request-auth';
import { createServiceClient } from '@/lib/supabase-utils';

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
    input = FsrsAuthorityActionSchema.parse(JSON.parse(bodyText));
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  try {
    const result = await applyFsrsAuthorityAction(createServiceClient(), input);
    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof FsrsAuthorityControlError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: 'FSRS_AUTHORITY_CONTROL_FAILED' },
      { status: 500 }
    );
  }
}

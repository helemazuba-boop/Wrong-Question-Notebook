import { NextResponse } from 'next/server';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  isValidUuid,
} from '@/lib/common-utils';
import { ProblemReviewSchedulerDiagnosticsSchema } from '@/lib/fsrs/diagnostics';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const { id: problemId } = await params;
  if (!isValidUuid(problemId)) {
    return NextResponse.json(
      createApiErrorResponse('Invalid problem ID format', 400),
      { status: 400 }
    );
  }

  const { data, error } = await supabase.rpc(
    'get_problem_review_scheduler_diagnostics',
    { p_problem_id: problemId }
  );
  if (error) {
    const notOwned =
      error.message.includes('PROBLEM_NOT_OWNED') ||
      error.message.includes('AUTHENTICATION_REQUIRED');
    return NextResponse.json(
      createApiErrorResponse(
        notOwned
          ? 'Scheduler diagnostics not found'
          : 'Diagnostics unavailable',
        notOwned ? 404 : 500
      ),
      { status: notOwned ? 404 : 500 }
    );
  }

  const parsed = ProblemReviewSchedulerDiagnosticsSchema.safeParse(data);
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse('Diagnostics unavailable', 500),
      { status: 500 }
    );
  }

  return NextResponse.json(createApiSuccessResponse(parsed.data));
}

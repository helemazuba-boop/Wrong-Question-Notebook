import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { AcceptProblemIngestionCandidatesSchema } from '@/lib/problem-ingestion-workspace-contract';
import {
  acceptProblemIngestionCandidates,
  ProblemIngestionWorkspaceError,
} from '@/lib/problem-ingestion-workspace-service';

function errorResponse(error: unknown) {
  if (error instanceof ProblemIngestionWorkspaceError) {
    return NextResponse.json(
      createApiErrorResponse(error.message, error.status, {
        code: error.code,
        details: error.details,
      }),
      { status: error.status }
    );
  }
  console.error('Problem ingestion candidate accept failed:', error);
  return NextResponse.json(
    createApiErrorResponse('Problem ingestion candidate accept failed', 500),
    { status: 500 }
  );
}

async function acceptCandidates(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json(
      createApiErrorResponse('Invalid ingestion ID', 400),
      { status: 400 }
    );
  }
  const parsed = AcceptProblemIngestionCandidatesSchema.safeParse(
    await req.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse(
        'Invalid accept request',
        400,
        parsed.error.flatten()
      ),
      { status: 400 }
    );
  }
  try {
    const workspace = await acceptProblemIngestionCandidates(
      supabase,
      user.id,
      id,
      parsed.data.question_ids
    );
    return NextResponse.json(createApiSuccessResponse({ workspace }));
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = withSecurity(acceptCandidates, { rateLimitType: 'api' });

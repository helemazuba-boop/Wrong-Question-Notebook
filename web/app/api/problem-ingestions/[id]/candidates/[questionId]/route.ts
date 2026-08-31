import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { UpdateProblemIngestionCandidateSchema } from '@/lib/problem-ingestion-workspace-contract';
import {
  ProblemIngestionWorkspaceError,
  updateProblemIngestionCandidate,
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
  console.error('Problem ingestion candidate update failed:', error);
  return NextResponse.json(
    createApiErrorResponse('Problem ingestion candidate update failed', 500),
    { status: 500 }
  );
}

async function updateCandidate(
  req: Request,
  { params }: { params: Promise<{ id: string; questionId: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const { id, questionId } = await params;
  if (!z.uuid().safeParse(id).success || questionId.length > 64) {
    return NextResponse.json(
      createApiErrorResponse('Invalid candidate ID', 400),
      { status: 400 }
    );
  }
  const parsed = UpdateProblemIngestionCandidateSchema.safeParse(
    await req.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse(
        'Invalid candidate update',
        400,
        parsed.error.flatten()
      ),
      { status: 400 }
    );
  }
  try {
    const workspace = await updateProblemIngestionCandidate(
      supabase,
      user.id,
      id,
      questionId,
      parsed.data
    );
    return NextResponse.json(createApiSuccessResponse({ workspace }));
  } catch (error) {
    return errorResponse(error);
  }
}

export const PATCH = withSecurity(updateCandidate, { rateLimitType: 'api' });

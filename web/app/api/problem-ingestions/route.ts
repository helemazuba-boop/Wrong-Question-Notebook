import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import {
  listProblemIngestionWorkspaces,
  persistExternalProblemIngestion,
  ProblemIngestionWorkspaceError,
} from '@/lib/problem-ingestion-workspace-service';

const CreateWorkspaceSchema = z
  .object({
    subject_id: z.uuid(),
    document: z.unknown(),
  })
  .strict();

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
  console.error('Problem ingestion workspace request failed:', error);
  return NextResponse.json(
    createApiErrorResponse('Problem ingestion request failed', 500),
    { status: 500 }
  );
}

async function listWorkspaces(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const subjectId = new URL(req.url).searchParams.get('subject_id');
  if (subjectId && !z.uuid().safeParse(subjectId).success) {
    return NextResponse.json(
      createApiErrorResponse('Invalid subject ID', 400),
      { status: 400 }
    );
  }
  try {
    const workspaces = await listProblemIngestionWorkspaces(
      supabase,
      user.id,
      subjectId
    );
    return NextResponse.json(createApiSuccessResponse({ workspaces }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function createWorkspace(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const parsed = CreateWorkspaceSchema.safeParse(
    await req.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse(
        'Invalid ingestion request',
        400,
        parsed.error.flatten()
      ),
      { status: 400 }
    );
  }
  try {
    const workspace = await persistExternalProblemIngestion(
      supabase,
      user.id,
      parsed.data.subject_id,
      parsed.data.document
    );
    return NextResponse.json(createApiSuccessResponse({ workspace }), {
      status: 201,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withSecurity(listWorkspaces, { rateLimitType: 'readOnly' });
export const POST = withSecurity(createWorkspace, { rateLimitType: 'api' });

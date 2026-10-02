import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import {
  deleteProblemIngestionWorkspace,
  getProblemIngestionWorkspace,
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
  console.error('Problem ingestion workspace request failed:', error);
  return NextResponse.json(
    createApiErrorResponse('Problem ingestion request failed', 500),
    { status: 500 }
  );
}

async function ingestionId(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    throw new ProblemIngestionWorkspaceError(
      'invalid_ingestion_id',
      'Invalid ingestion ID',
      400
    );
  }
  return id;
}

async function getWorkspace(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  try {
    const workspace = await getProblemIngestionWorkspace(
      supabase,
      user.id,
      await ingestionId(params)
    );
    return NextResponse.json(createApiSuccessResponse({ workspace }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function deleteWorkspace(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  try {
    await deleteProblemIngestionWorkspace(
      supabase,
      user.id,
      await ingestionId(params)
    );
    return NextResponse.json(createApiSuccessResponse({ deleted: true }));
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withSecurity(getWorkspace, { rateLimitType: 'readOnly' });
export const DELETE = withSecurity(deleteWorkspace, { rateLimitType: 'api' });

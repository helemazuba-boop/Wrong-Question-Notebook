import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CreateProblemDto } from '@/lib/schemas';
import { deriveProblemImageAssets } from '@/lib/problem-image-service';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
  hasOnlyOwnedAssetPaths,
} from '@/lib/common-utils';
import { ERROR_MESSAGES } from '@/lib/constants';

const AssetBody = z.strictObject({
  assets: CreateProblemDto.shape.assets.unwrap().max(100).optional(),
  solution_assets: CreateProblemDto.shape.solution_assets
    .unwrap()
    .max(100)
    .optional(),
  expected_revision: z.number().int().positive().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const { id: problemId } = await params;

  if (!problemId) {
    return NextResponse.json(
      createApiErrorResponse('Problem ID is required', 400),
      { status: 400 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json(
      createApiErrorResponse(
        ERROR_MESSAGES.INVALID_REQUEST,
        400,
        error as string
      ),
      { status: 400 }
    );
  }

  const parsed = AssetBody.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(createApiErrorResponse('Invalid assets', 400), {
      status: 400,
    });
  const { assets, solution_assets, expected_revision } = parsed.data;
  if (!hasOnlyOwnedAssetPaths(user.id, assets, solution_assets))
    return NextResponse.json(createApiErrorResponse('Asset not owned', 403), {
      status: 403,
    });

  // Validate that at least one asset array is provided
  if (assets === undefined && solution_assets === undefined) {
    return NextResponse.json(
      createApiErrorResponse(
        'Either assets or solution_assets must be provided',
        400
      ),
      { status: 400 }
    );
  }

  try {
    const { data: current, error: readError } = await supabase
      .from('problems')
      .select('revision')
      .eq('id', problemId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (readError || !current)
      return NextResponse.json(
        createApiErrorResponse('Problem not found', 404),
        { status: 404 }
      );
    // Update only the provided asset columns
    const updateData: Partial<{
      assets: Array<{ path: string }>;
      solution_assets: Array<{ path: string }>;
    }> = {};
    if (assets !== undefined) {
      updateData.assets = await deriveProblemImageAssets(assets);
    }
    if (solution_assets !== undefined) {
      updateData.solution_assets =
        await deriveProblemImageAssets(solution_assets);
    }

    const { data: updated, error } = await supabase
      .from('problems')
      .update(updateData)
      .eq('id', problemId)
      .eq('user_id', user.id)
      .eq('revision', expected_revision ?? current.revision)
      .select('assets, solution_assets')
      .single();

    if (error) {
      if (error.code === 'PGRST116')
        return NextResponse.json(
          createApiErrorResponse('Revision conflict', 409),
          { status: 409 }
        );
      return NextResponse.json(
        createApiErrorResponse(
          ERROR_MESSAGES.DATABASE_ERROR,
          500,
          error.message
        ),
        { status: 500 }
      );
    }

    return NextResponse.json(
      createApiSuccessResponse({
        assets: updated.assets,
        solution_assets: updated.solution_assets,
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

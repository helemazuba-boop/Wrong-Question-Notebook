import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { UpdateAttemptDto } from '@/lib/schemas';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { ERROR_MESSAGES } from '@/lib/constants';
import type { Database, Json } from '@/lib/database.types';
import { revalidateProblemAndSubject } from '@/lib/cache-invalidation';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const { id: attemptId } = await params;
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

  const parsed = UpdateAttemptDto.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse(
        'Invalid request body',
        400,
        parsed.error.flatten()
      ),
      { status: 400 }
    );
  }

  try {
    const updatePayload: Record<string, unknown> = { ...parsed.data };
    if (updatePayload.submitted_answer !== undefined) {
      updatePayload.submitted_answer = updatePayload.submitted_answer as Json;
    }

    const { data, error } = await supabase
      .from('attempts')
      .update(
        updatePayload as Database['public']['Tables']['attempts']['Update']
      )
      .eq('id', attemptId)
      .eq('user_id', user.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        createApiErrorResponse(
          ERROR_MESSAGES.DATABASE_ERROR,
          500,
          error.message
        ),
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json(
        createApiErrorResponse(ERROR_MESSAGES.NOT_FOUND, 404),
        { status: 404 }
      );
    }

    // Attempt edits never create or correct a Review. Rating corrections use
    // the stable occurrence through /api/problem-reviews.
    const { data: problem } = await supabase
      .from('problems')
      .select('subject_id')
      .eq('id', data.problem_id)
      .eq('user_id', user.id)
      .single();
    if (problem) {
      await revalidateProblemAndSubject(data.problem_id, problem.subject_id);
    }

    return NextResponse.json(createApiSuccessResponse(data));
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

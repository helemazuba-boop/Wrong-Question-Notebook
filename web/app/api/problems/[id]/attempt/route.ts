import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/requireUser';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { ERROR_MESSAGES } from '@/lib/constants';
import { revalidateProblemAndSubject } from '@/lib/cache-invalidation';
import { markProblem } from '@/lib/answer-marking';
import { createServiceClient } from '@/lib/supabase-utils';
import { StoredProblemPartsSchema } from '@/lib/schemas';
import type { ProblemPart } from '@/lib/types';
import { z } from 'zod';

// Shell model: one answer per part, keyed by the part index.
const AttemptBodySchema = z.object({
  answers: z
    .array(
      z.object({
        index: z.number().int().min(1).max(10),
        answer: z.unknown(),
      })
    )
    .min(1),
  record: z.boolean().default(true),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();

  const { id: problemId } = await params;
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

  const parsedBody = AttemptBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      createApiErrorResponse(ERROR_MESSAGES.INVALID_REQUEST, 400),
      { status: 400 }
    );
  }
  const { answers, record } = parsedBody.data;

  try {
    // Use service client to fetch the problem so non-owner viewers
    // (accessing via shared problem sets) can also auto-mark answers
    const serviceClient = createServiceClient();

    const { data: problem, error: problemError } = await serviceClient
      .from('problems')
      .select('*')
      .eq('id', problemId)
      .single();

    if (problemError || !problem) {
      return NextResponse.json(
        createApiErrorResponse(ERROR_MESSAGES.NOT_FOUND, 404),
        { status: 404 }
      );
    }

    // Stored parts may carry non-standard answer_config blobs (word_mistake
    // projection rows); the tolerant schema accepts them and the marking
    // engine treats them as non-markable.
    const parsedParts = StoredProblemPartsSchema.safeParse(problem.parts);
    if (!parsedParts.success) {
      return NextResponse.json(
        createApiErrorResponse(ERROR_MESSAGES.DATABASE_ERROR, 500),
        { status: 500 }
      );
    }
    const parts = parsedParts.data as ProblemPart[];

    const answerMap = new Map<number, unknown>(
      answers.map(entry => [entry.index, entry.answer])
    );
    const marked = markProblem(parts, answerMap);

    if (!marked.auto_marked) {
      // No part carries an answer key: nothing to auto-mark (the review flow
      // self-assesses these shells instead of calling this endpoint).
      return NextResponse.json(
        createApiErrorResponse(
          'Auto-marking is not enabled for this problem',
          400
        ),
        { status: 400 }
      );
    }

    // is_correct is only a verdict when EVERY part got one; a shell with a
    // pending self-assessed part stays null until the user confirms via
    // PATCH /api/attempts/[id].
    const fullyAutoMarked = marked.part_results.every(
      result => result.correct !== null
    );
    const isCorrect = fullyAutoMarked ? marked.all_correct : null;

    if (user) {
      if (record) {
        // Authenticated user: create attempt record
        const attemptData = {
          problem_id: problemId,
          submitted_answer:
            answers as unknown as import('@/lib/database.types').Json,
          part_results:
            marked.part_results as unknown as import('@/lib/database.types').Json,
          is_correct: isCorrect,
          user_id: user.id,
        };

        const { data: attempt, error: attemptError } = await supabase
          .from('attempts')
          .insert(attemptData)
          .select()
          .single();

        if (attemptError) {
          return NextResponse.json(
            createApiErrorResponse(
              ERROR_MESSAGES.DATABASE_ERROR,
              500,
              attemptError.message
            ),
            { status: 500 }
          );
        }

        // Invalidate cache after successful attempt creation
        await revalidateProblemAndSubject(problemId, problem.subject_id);

        // Attempt persistence is machine evidence only. The human-final Rating
        // is recorded separately through /api/problem-reviews.

        return NextResponse.json(
          createApiSuccessResponse({
            data: attempt,
            is_correct: isCorrect,
            part_results: marked.part_results,
            total_score: marked.total_score,
            total_full_marks: marked.total_full_marks,
          })
        );
      }

      // Mark-only mode: return correctness without saving
      return NextResponse.json(
        createApiSuccessResponse({
          data: null,
          is_correct: isCorrect,
          part_results: marked.part_results,
          total_score: marked.total_score,
          total_full_marks: marked.total_full_marks,
        })
      );
    }

    // Anonymous user: return correctness without saving an attempt record
    return NextResponse.json(
      createApiSuccessResponse({
        data: { is_correct: isCorrect },
        is_correct: isCorrect,
        part_results: marked.part_results,
        total_score: marked.total_score,
        total_full_marks: marked.total_full_marks,
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

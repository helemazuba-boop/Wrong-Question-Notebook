import { NextResponse } from 'next/server';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { ProblemReviewIdeaDto } from '@/lib/schemas';
import { withSecurity } from '@/lib/security-middleware';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';

async function setReviewIdea(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const parsed = ProblemReviewIdeaDto.safeParse(await req.json());
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

  const { data, error } = await supabase.rpc('set_problem_review_idea', {
    p_review_occurrence_id: parsed.data.review_occurrence_id,
    p_revision_kind: parsed.data.idea === null ? 'clear' : 'set',
    p_idea: parsed.data.idea,
  });

  if (error) {
    const status = error.message.includes('REVIEW_OCCURRENCE_NOT_OWNED')
      ? 404
      : 500;
    return NextResponse.json(
      createApiErrorResponse(
        status === 404 ? 'Review not found' : 'Failed to save Review idea',
        status
      ),
      { status }
    );
  }

  return NextResponse.json(createApiSuccessResponse(data));
}

export const POST = withSecurity(setReviewIdea, { rateLimitType: 'api' });

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { AI_CONSTANTS } from '@/lib/constants';
import {
  extractProblemFromImages,
  ProblemExtractionServiceError,
  PROBLEM_EXTRACTION_MIME_TYPES,
} from '@/lib/problem-extraction-service';
import { PROBLEM_IMAGE_MAX_BASE64_CHARS } from '@/lib/image-input-normalization';

const RequestSchema = z.object({
  image: z.string().min(1).max(PROBLEM_IMAGE_MAX_BASE64_CHARS),
  mimeType: z.enum(PROBLEM_EXTRACTION_MIME_TYPES),
  subjectId: z.uuid().optional(),
});

async function extractProblem(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      createApiErrorResponse('Invalid request body', 400),
      { status: 400 }
    );
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse('Invalid request', 400, parsed.error.flatten()),
      { status: 400 }
    );
  }

  try {
    const result = await extractProblemFromImages(
      supabase,
      user.id,
      [
        {
          data: parsed.data.image,
          mime_type: parsed.data.mimeType,
        },
      ],
      parsed.data.subjectId
    );
    const firstPart = result.extraction.parts[0];
    return NextResponse.json(
      createApiSuccessResponse({
        title: result.extraction.title,
        content: result.extraction.content,
        parts: result.extraction.parts,
        suggest_image_asset: result.extraction.suggest_image_asset,
        suggested_tags: result.suggested_tags,
        confidence: result.extraction.confidence,
        // Legacy mirror for clients that still render the first part through
        // the pre-shell fields.
        problem_type: firstPart.type,
        mcq_choices: firstPart.mcq_choices,
        answer_hint: firstPart.answer_hint,
        quota: result.quota,
      })
    );
  } catch (error) {
    if (error instanceof ProblemExtractionServiceError) {
      return NextResponse.json(
        createApiErrorResponse(error.message, error.status, error.details),
        { status: error.status }
      );
    }
    return NextResponse.json(
      createApiErrorResponse('Problem extraction failed', 503),
      { status: 503 }
    );
  }
}

export const POST = withSecurity(extractProblem, {
  rateLimitType: 'custom',
  customRateLimit: AI_CONSTANTS.EXTRACTION.RATE_LIMIT,
});

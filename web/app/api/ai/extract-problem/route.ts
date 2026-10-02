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
  ingestProblemsFromImages,
  persistProblemIngestion,
  ProblemExtractionServiceError,
  PROBLEM_EXTRACTION_MIME_TYPES,
} from '@/lib/problem-extraction-service';
import {
  PROBLEM_IMAGE_MAX_BASE64_CHARS,
  PROBLEM_IMAGE_MAX_COUNT,
} from '@/lib/image-input-normalization';

const ImageSchema = z.object({
  image: z.string().min(1).max(PROBLEM_IMAGE_MAX_BASE64_CHARS),
  mimeType: z.enum(PROBLEM_EXTRACTION_MIME_TYPES),
});

const RequestSchema = z
  .object({
    // Legacy single-image fields remain accepted by deployed clients.
    image: z.string().min(1).max(PROBLEM_IMAGE_MAX_BASE64_CHARS).optional(),
    mimeType: z.enum(PROBLEM_EXTRACTION_MIME_TYPES).optional(),
    images: z.array(ImageSchema).min(1).max(PROBLEM_IMAGE_MAX_COUNT).optional(),
    subjectId: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const hasLegacy = value.image !== undefined || value.mimeType !== undefined;
    if (value.images && hasLegacy) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide images or the legacy image/mimeType pair, not both',
      });
    } else if (!value.images && !(value.image && value.mimeType)) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one image is required',
      });
    }
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
    const images = parsed.data.images ?? [
      {
        image: parsed.data.image!,
        mimeType: parsed.data.mimeType!,
      },
    ];
    const result = await ingestProblemsFromImages(
      supabase,
      user.id,
      images.map(image => ({
        data: image.image,
        mime_type: image.mimeType,
      })),
      parsed.data.subjectId
    );
    const ingestionId = await persistProblemIngestion(
      supabase,
      user.id,
      parsed.data.subjectId,
      result.document
    );
    const candidates = result.candidates.map(candidate => {
      const firstPart = candidate.extraction.parts[0];
      return {
        title: candidate.extraction.title,
        content: candidate.extraction.content,
        parts: candidate.extraction.parts,
        suggest_image_asset: candidate.extraction.suggest_image_asset,
        suggested_tags: candidate.suggested_tags,
        confidence: candidate.extraction.confidence,
        problem_type: firstPart.type,
        mcq_choices: firstPart.mcq_choices,
        answer_hint: firstPart.answer_hint,
        ingestion_id: ingestionId,
        ingestion_schema_version: result.document.schema_version,
        ingestion_question_id: candidate.question_id,
        question_number_label: candidate.number_label,
        source_region_ids: candidate.source_region_ids,
        visual_region_ids: candidate.visual_region_ids,
        student_work_count: candidate.student_work_count,
        incomplete: candidate.incomplete,
      };
    });
    const first = candidates[0];
    return NextResponse.json(
      createApiSuccessResponse({
        ...first,
        candidates,
        ingestion: {
          id: ingestionId,
          schema_version: result.document.schema_version,
          status: result.document.status,
        },
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

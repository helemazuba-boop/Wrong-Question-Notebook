import { NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
  isValidUuid,
} from '@/lib/common-utils';
import {
  getEsp32RequestOrigin,
  serializeEsp32ProblemContent,
} from '@/lib/esp32-content';
import { createServiceClient } from '@/lib/supabase-utils';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';

async function getProblems(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { userId } = authResult;
  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get('ids');

  if (!idsParam) {
    return NextResponse.json(
      createApiErrorResponse('Problem IDs are required', 400),
      { status: 400 }
    );
  }

  const problemIds = idsParam
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .slice(0, 50); // Max 50 problems per request

  if (problemIds.length === 0) {
    return NextResponse.json(
      createApiErrorResponse('No valid problem IDs provided', 400),
      { status: 400 }
    );
  }

  // Validate UUIDs
  for (const id of problemIds) {
    if (!isValidUuid(id)) {
      return NextResponse.json(
        createApiErrorResponse(`Invalid problem ID format: ${id}`, 400),
        { status: 400 }
      );
    }
  }

  try {
    const svc = createServiceClient();

    // Fetch problems with minimal data needed for ESP32
    const { data: problems, error } = await svc
      .from('problems')
      .select(
        `
        id,
        title,
        content,
        problem_type,
        answer_config,
        solution_text,
        assets,
        solution_assets
      `
      )
      .eq('user_id', userId)
      .in('id', problemIds);

    if (error) {
      return NextResponse.json(
        createApiErrorResponse('Failed to fetch problems', 500),
        { status: 500 }
      );
    }

    const origin = getEsp32RequestOrigin(req);

    // Transform to ESP32-friendly format
    const transformed = (problems || []).map(p => ({
      id: p.id,
      title: p.title,
      content: p.content,
      problem_type: p.problem_type,
      // Strip answer choices from MCQ to avoid revealing answer on ESP32
      // Just send the answer mode, not actual correct answer
      answer_config:
        p.problem_type === 'mcq'
          ? { mode: (p.answer_config as any)?.mode || 'choice' }
          : p.answer_config,
      ...serializeEsp32ProblemContent(
        p.content,
        p.solution_text,
        p.assets,
        p.solution_assets,
        origin
      ),
    }));

    return NextResponse.json(
      createApiSuccessResponse({ problems: transformed })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const GET = withSecurity(getProblems, {
  enableRateLimit: false,
  enableRequestValidation: false,
});

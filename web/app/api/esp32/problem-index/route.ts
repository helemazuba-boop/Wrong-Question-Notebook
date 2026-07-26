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

type ProblemStatus = 'wrong' | 'needs_review' | 'mastered';

const VALID_STATUSES: ProblemStatus[] = ['wrong', 'needs_review', 'mastered'];

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '50', 10);
  if (Number.isNaN(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 100);
}

function parseCursor(value: string | null): number | NextResponse {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0 || String(parsed) !== value) {
    return NextResponse.json(createApiErrorResponse('Invalid cursor', 400), {
      status: 400,
    });
  }
  return parsed;
}

function parseStatus(
  value: string | null
): ProblemStatus | NextResponse | null {
  if (!value) return null;
  if (VALID_STATUSES.includes(value as ProblemStatus)) {
    return value as ProblemStatus;
  }
  return NextResponse.json(createApiErrorResponse('Invalid status', 400), {
    status: 400,
  });
}

async function getProblemIndex(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { userId, deviceId } = authResult;
  const { searchParams } = new URL(req.url);
  const limit = parseLimit(searchParams.get('limit'));
  const cursor = parseCursor(searchParams.get('cursor'));
  if (cursor instanceof NextResponse) return cursor;

  const status = parseStatus(searchParams.get('status'));
  if (status instanceof NextResponse) return status;

  const subjectId = searchParams.get('subject_id');
  if (subjectId && !isValidUuid(subjectId)) {
    return NextResponse.json(
      createApiErrorResponse('Invalid subject_id format', 400),
      { status: 400 }
    );
  }

  try {
    const svc = createServiceClient();

    let query = svc
      .from('problems')
      .select(
        `
        id,
        title,
        content,
        parts,
        status,
        subject_id,
        updated_at,
        solution_text,
        assets,
        solution_assets
      `,
        { count: 'exact' }
      )
      .eq('user_id', userId);

    if (status) query = query.eq('status', status);
    if (subjectId) query = query.eq('subject_id', subjectId);

    const {
      data: problems,
      error,
      count,
    } = await query
      .order('updated_at', { ascending: false })
      .range(cursor, cursor + limit - 1);

    if (error) {
      return NextResponse.json(
        createApiErrorResponse('Failed to fetch problem index', 500),
        { status: 500 }
      );
    }

    const problemIds = (problems || []).map(problem => problem.id);
    const subjectIds = [
      ...new Set((problems || []).map(problem => problem.subject_id)),
    ].filter(Boolean);

    const [scheduleResult, subjectResult] = await Promise.all([
      problemIds.length > 0
        ? svc
            .from('review_schedule')
            .select('problem_id, next_review_at')
            .eq('user_id', userId)
            .in('problem_id', problemIds)
        : Promise.resolve({ data: [], error: null }),
      subjectIds.length > 0
        ? svc
            .from('subjects')
            .select('id, name')
            .eq('user_id', userId)
            .in('id', subjectIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (scheduleResult.error || subjectResult.error) {
      return NextResponse.json(
        createApiErrorResponse('Failed to load problem metadata', 500),
        { status: 500 }
      );
    }

    const schedules = scheduleResult.data;
    const subjects = subjectResult.data;

    const scheduleByProblemId = new Map(
      (schedules || []).map(schedule => [
        schedule.problem_id,
        schedule.next_review_at,
      ])
    );
    const subjectNameById = new Map(
      (subjects || []).map(subject => [subject.id, subject.name])
    );

    const total = count || 0;
    const nextOffset = cursor + (problems || []).length;
    const hasMore = nextOffset < total;
    const now = new Date().toISOString();
    const origin = getEsp32RequestOrigin(req);

    await svc
      .from('esp32_devices')
      .update({ last_seen_at: now, last_sync_at: now })
      .eq('id', deviceId);

    return NextResponse.json(
      createApiSuccessResponse({
        problems: (problems || []).map(problem => ({
          id: problem.id,
          title: problem.title,
          content: problem.content,
          // Shell model: legacy devices get the distinct part types.
          part_types: Array.isArray(problem.parts)
            ? [...new Set((problem.parts as any[]).map(part => part?.type))]
            : [],
          status: problem.status,
          subject_id: problem.subject_id,
          subject_name: subjectNameById.get(problem.subject_id) || '',
          updated_at: problem.updated_at,
          next_review_at: scheduleByProblemId.get(problem.id) || null,
          ...serializeEsp32ProblemContent(
            problem.content,
            problem.solution_text,
            problem.assets,
            problem.solution_assets,
            origin
          ),
        })),
        next_cursor: hasMore ? String(nextOffset) : '',
        has_more: hasMore,
        total,
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const GET = withSecurity(getProblemIndex, {
  enableRateLimit: false,
  enableRequestValidation: false,
});

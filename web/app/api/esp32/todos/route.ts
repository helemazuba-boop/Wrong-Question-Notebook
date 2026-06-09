import { NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createApiErrorResponse, createApiSuccessResponse } from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { loadEsp32TodoTimeline } from '@/lib/todos';

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '24', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 24) : 24;
}

export async function GET(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get('scope') || 'timeline';
  const status = searchParams.get('status') || 'pending';
  if (!['timeline', 'today'].includes(scope) || status !== 'pending') {
    return NextResponse.json(
      createApiErrorResponse('Only pending Todo timeline is supported', 400, {
        code: 'invalid_request',
      }),
      { status: 400 }
    );
  }

  try {
    const timeline = await loadEsp32TodoTimeline(createServiceClient(), authResult.userId, {
      limit: parseLimit(searchParams.get('limit')),
      cursor: searchParams.get('cursor'),
    });

    return NextResponse.json(createApiSuccessResponse(timeline));
  } catch {
    return NextResponse.json(
      createApiErrorResponse('Failed to load Todo list', 500, {
        code: 'todo_failed',
      }),
      { status: 500 }
    );
  }
}

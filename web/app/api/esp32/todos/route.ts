import { NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createApiErrorResponse, createApiSuccessResponse } from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { loadEsp32TodayTodos } from '@/lib/todos';

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '8', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 8) : 8;
}

export async function GET(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get('scope') || 'today';
  const status = searchParams.get('status') || 'pending';
  if (scope !== 'today' || status !== 'pending') {
    return NextResponse.json(
      createApiErrorResponse('Only today pending Todo scope is supported', 400, {
        code: 'invalid_request',
      }),
      { status: 400 }
    );
  }

  try {
    const todos = await loadEsp32TodayTodos(
      createServiceClient(),
      authResult.userId,
      parseLimit(searchParams.get('limit'))
    );

    return NextResponse.json(createApiSuccessResponse({ todos }));
  } catch {
    return NextResponse.json(
      createApiErrorResponse('Failed to load Todo list', 500, {
        code: 'todo_failed',
      }),
      { status: 500 }
    );
  }
}

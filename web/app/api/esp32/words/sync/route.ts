import { NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createApiErrorResponse, createApiSuccessResponse } from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  loadEsp32WordSync,
  wordErrorResponse,
  WordToolError,
} from '@/lib/words';

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '200', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 200;
}

export async function GET(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const { searchParams } = new URL(req.url);
    const result = await loadEsp32WordSync(createServiceClient(), authResult.userId, {
      since: searchParams.get('since'),
      limit: parseLimit(searchParams.get('limit')),
    });
    return NextResponse.json(createApiSuccessResponse(result));
  } catch (error) {
    if (error instanceof WordToolError) return wordErrorResponse(error);
    return NextResponse.json(
      createApiErrorResponse('Failed to sync words', 500, {
        code: 'word_sync_failed',
      }),
      { status: 500 }
    );
  }
}

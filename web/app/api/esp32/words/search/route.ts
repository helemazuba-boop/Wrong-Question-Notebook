import { NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createApiErrorResponse, createApiSuccessResponse } from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  searchWords,
  wordErrorResponse,
  WordToolError,
} from '@/lib/words';

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '8', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 8) : 8;
}

export async function GET(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const { searchParams } = new URL(req.url);
    const prefix = searchParams.get('prefix');
    const q = searchParams.get('q');
    if (!prefix && !q) {
      throw new WordToolError('invalid_request', 'prefix or q is required', 400);
    }

    const data = await searchWords(createServiceClient(), authResult.userId, {
      prefix,
      q,
      limit: parseLimit(searchParams.get('limit')),
    });
    return NextResponse.json(createApiSuccessResponse(data));
  } catch (error) {
    if (error instanceof WordToolError) return wordErrorResponse(error);
    return NextResponse.json(
      createApiErrorResponse('Failed to search words', 500, {
        code: 'word_search_failed',
      }),
      { status: 500 }
    );
  }
}

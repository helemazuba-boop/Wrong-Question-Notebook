import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createApiErrorResponse, createApiSuccessResponse } from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  getWordDetail,
  wordErrorResponse,
  WordToolError,
} from '@/lib/words';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const parsed = ParamsSchema.safeParse(await context.params);
    if (!parsed.success) {
      throw new WordToolError('invalid_request', 'Invalid word id', 400);
    }

    const word = await getWordDetail(
      createServiceClient(),
      authResult.userId,
      parsed.data.id
    );
    return NextResponse.json(createApiSuccessResponse({ word }));
  } catch (error) {
    if (error instanceof WordToolError) return wordErrorResponse(error);
    return NextResponse.json(
      createApiErrorResponse('Failed to load word detail', 500, {
        code: 'word_detail_failed',
      }),
      { status: 500 }
    );
  }
}

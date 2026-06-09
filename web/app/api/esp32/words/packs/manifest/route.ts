import { NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { loadWordPackManifest } from '@/lib/word-packs';
import { WordToolError, wordErrorResponse } from '@/lib/words';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const origin = new URL(req.url).origin;
    const manifest = await loadWordPackManifest(
      createServiceClient(),
      authResult.userId,
      origin
    );

    return NextResponse.json(createApiSuccessResponse(manifest));
  } catch (error) {
    if (error instanceof WordToolError) return wordErrorResponse(error);
    return NextResponse.json(
      createApiErrorResponse('Failed to load word pack manifest', 500, {
        code: 'word_pack_manifest_failed',
      }),
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createApiErrorResponse } from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { getDownloadableWordPack } from '@/lib/word-packs';
import { WordToolError, wordErrorResponse } from '@/lib/words';

export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const { id } = await params;
    const { pack, deck, body } = await getDownloadableWordPack(
      createServiceClient(),
      authResult.userId,
      id
    );

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Length': String(pack.byte_size),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"${pack.sha256}"`,
        'X-WQN-Word-Pack-Id': pack.id,
        'X-WQN-Word-Deck-Id': deck.id,
        'X-WQN-Word-Deck-Title': encodeURIComponent(deck.title),
        'X-WQN-Word-Pack-Revision': String(pack.revision),
        'X-WQN-Word-Pack-SHA256': pack.sha256,
      },
    });
  } catch (error) {
    if (error instanceof WordToolError) return wordErrorResponse(error);
    return NextResponse.json(
      createApiErrorResponse('Failed to download word pack', 500, {
        code: 'word_pack_download_failed',
      }),
      { status: 500 }
    );
  }
}

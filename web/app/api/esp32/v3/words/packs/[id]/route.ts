import { NextRequest, NextResponse } from 'next/server';
import { deflateSync } from 'zlib';
import {
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import { authenticateDeviceControlV3 } from '@/lib/device-control-v3-auth';
import { getDownloadableWordPack } from '@/lib/word-packs';
import { wordStudyErrorResponse } from '@/lib/word-study-route';
import { createServiceClient } from '@/lib/supabase-utils';

export const runtime = 'nodejs';

async function downloadPack(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, requestId);
  if (protocolError) return protocolError;

  const auth = await authenticateDeviceControlV3(req, requestId);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const { pack, deck, body } = await getDownloadableWordPack(
      createServiceClient(),
      auth.userId,
      id
    );
    // Transport coding only: the stored pack stays plain JSONL; the manifest
    // advertises compression=zlib and the device inflates while streaming.
    // sha256/byte_size keep describing the uncompressed content.
    const deflated = deflateSync(Buffer.from(new Uint8Array(body)));
    return new NextResponse(new Uint8Array(deflated), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(deflated.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"${pack.sha256}"`,
        'X-WQN-Protocol': '3',
        'X-WQN-Request-Id': requestId,
        'X-WQN-Compression': 'zlib',
        'X-WQN-Word-Pack-Id': pack.id,
        'X-WQN-Word-Deck-Id': deck.id,
        'X-WQN-Word-Deck-Title': encodeURIComponent(deck.title),
        'X-WQN-Word-Pack-Revision': String(pack.revision),
        'X-WQN-Word-Pack-SHA256': pack.sha256,
      },
    });
  } catch (error) {
    return wordStudyErrorResponse(requestId, error);
  }
}

export const GET = withV3Security(downloadPack, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

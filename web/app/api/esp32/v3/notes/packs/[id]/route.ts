import { NextRequest, NextResponse } from 'next/server';
import { deflateSync } from 'zlib';
import {
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import { authenticateDeviceControlV3 } from '@/lib/device-control-v3-auth';
import { getDownloadableNotePack } from '@/lib/note-packs';
import { noteStudyErrorResponse } from '@/lib/note-study-route';
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
    const { pack, notebook, body } = await getDownloadableNotePack(
      createServiceClient(),
      auth.userId,
      id
    );
    // Transport coding only (see the word pack route): body deflated, hashes
    // and byte_size keep describing the uncompressed JSONL.
    const deflated = deflateSync(Buffer.from(body, 'utf8'));
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
        'X-WQN-Note-Pack-Id': pack.id,
        'X-WQN-Notebook-Id': notebook.id,
        'X-WQN-Notebook-Title': encodeURIComponent(notebook.title),
        'X-WQN-Note-Pack-Revision': String(pack.revision),
        'X-WQN-Note-Pack-SHA256': pack.sha256,
      },
    });
  } catch (error) {
    return noteStudyErrorResponse(requestId, error);
  }
}

export const GET = withV3Security(downloadPack, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

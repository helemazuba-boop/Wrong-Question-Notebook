import { NextRequest, NextResponse } from 'next/server';
import { deflateSync } from 'zlib';
import {
  createV3Error,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import { authenticateDeviceControlV3 } from '@/lib/device-control-v3-auth';
import { FILE_CONSTANTS } from '@/lib/constants';
import { createServiceClient } from '@/lib/supabase-utils';

export const runtime = 'nodejs';

// Serves a problem image as the device-ready WQNI file (mirrors the note
// image route). Addressed by problem id + asset kind + attachment index so
// the device needs nothing beyond what the pack JSONL already carries
// (image_ids / solution_image_ids); the X-WQN-Image-Id header lets it verify
// the pack's image_id before caching.

async function downloadProblemImage(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ problemId: string; kind: string; index: string }> }
) {
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, requestId);
  if (protocolError) return protocolError;

  const auth = await authenticateDeviceControlV3(req, requestId);
  if (auth instanceof NextResponse) return auth;

  const { problemId, kind, index } = await params;
  const imageIndex = Number(index);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      problemId
    ) ||
    (kind !== 'assets' && kind !== 'solution') ||
    !Number.isInteger(imageIndex) ||
    imageIndex < 0 ||
    imageIndex > 7
  ) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }

  try {
    const service = createServiceClient();
    const { data: problem, error } = await service
      .from('problems')
      .select('assets, solution_assets')
      .eq('id', problemId)
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (error) {
      return createV3Error(requestId, 500, 'DATABASE_ERROR', true);
    }
    const column =
      kind === 'assets' ? problem?.assets : problem?.solution_assets;
    // The pack indexes image-bearing assets only, so PDFs and underived
    // photos are filtered out before indexing (matches imageIdsOf).
    const assets = (Array.isArray(column) ? column : []).filter(
      entry =>
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as { image_id?: unknown }).image_id === 'string'
    );
    const asset = assets[imageIndex] as
      { image_id?: string; display_path?: string } | undefined;
    if (!asset?.image_id || !asset?.display_path) {
      return createV3Error(requestId, 404, 'IMAGE_NOT_FOUND', false);
    }

    const { data: blob, error: downloadError } = await service.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .download(asset.display_path);
    if (downloadError || !blob) {
      return createV3Error(requestId, 404, 'IMAGE_NOT_FOUND', false);
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    // Transport coding only: image_id stays the sha256 of the uncompressed
    // WQNI file; the device inflates (ROM tinfl) before verifying it.
    const deflated = deflateSync(bytes);

    return new NextResponse(new Uint8Array(deflated), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(deflated.length),
        // image_id is a content hash, so the bytes are immutable.
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"${asset.image_id}"`,
        'X-WQN-Protocol': '3',
        'X-WQN-Request-Id': requestId,
        'X-WQN-Compression': 'zlib',
        'X-WQN-Image-Id': asset.image_id,
      },
    });
  } catch {
    return createV3Error(requestId, 500, 'INTERNAL_ERROR', true);
  }
}

export const GET = withV3Security(downloadProblemImage, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

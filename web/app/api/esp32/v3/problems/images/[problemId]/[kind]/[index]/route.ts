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

// Serves a problem image as device-ready WQNI (BW1 by default, or the 4bpp
// derivative selected by pixel_format=gray4). Addressed by problem id +
// asset kind + attachment index so
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
  const pixelFormat = req.nextUrl.searchParams.get('pixel_format') ?? 'bw1';
  const imageIndex = Number(index);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      problemId
    ) ||
    (kind !== 'assets' && kind !== 'solution') ||
    !Number.isInteger(imageIndex) ||
    imageIndex < 0 ||
    imageIndex > 7 ||
    (pixelFormat !== 'bw1' && pixelFormat !== 'gray4')
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
      | {
          image_id?: string;
          display_path?: string;
          gray4_image_id?: string;
          gray4_display_path?: string;
        }
      | undefined;
    if (!asset?.image_id || !asset?.display_path) {
      return createV3Error(requestId, 404, 'IMAGE_NOT_FOUND', false);
    }
    const selectedId =
      pixelFormat === 'gray4' ? asset.gray4_image_id : asset.image_id;
    const selectedPath =
      pixelFormat === 'gray4' ? asset.gray4_display_path : asset.display_path;
    if (!selectedId || !selectedPath) {
      return createV3Error(requestId, 404, 'IMAGE_VARIANT_NOT_FOUND', false);
    }

    const { data: blob, error: downloadError } = await service.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .download(selectedPath);
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
        ETag: `"${selectedId}"`,
        'X-WQN-Protocol': '3',
        'X-WQN-Request-Id': requestId,
        'X-WQN-Compression': 'zlib',
        'X-WQN-Image-Id': selectedId,
        'X-WQN-Pixel-Format': pixelFormat,
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

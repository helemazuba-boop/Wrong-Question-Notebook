import { NextRequest, NextResponse } from 'next/server';
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

// Serves a note image as the device-ready WQNI file (20-byte header + 15000
// byte 1-bpp framebuffer payload). Addressed by note id + attachment index so
// the device needs nothing beyond what the pack JSONL already carries; the
// X-WQN-Image-Id header lets it verify the pack's image_id before caching.

async function downloadNoteImage(
  req: NextRequest,
  { params }: { params: Promise<{ noteId: string; index: string }> }
) {
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, requestId);
  if (protocolError) return protocolError;

  const auth = await authenticateDeviceControlV3(req, requestId);
  if (auth instanceof NextResponse) return auth;

  const { noteId, index } = await params;
  const imageIndex = Number(index);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      noteId
    ) ||
    !Number.isInteger(imageIndex) ||
    imageIndex < 0 ||
    imageIndex > 3
  ) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }

  try {
    const service = createServiceClient();
    // database.types.ts predates the assets column (it is stale for several
    // note columns); the untyped row read matches the content service's
    // SupabaseClient<any> convention.
    const { data: note, error } = await service
      .from('notebook_notes')
      .select('assets')
      .eq('id', noteId)
      .eq('user_id', auth.userId)
      .is('archived_at', null)
      .maybeSingle<{ assets: unknown }>();
    if (error) {
      return createV3Error(requestId, 500, 'DATABASE_ERROR', true);
    }
    const assets = Array.isArray(note?.assets) ? note.assets : [];
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

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        // image_id is a content hash, so the bytes are immutable.
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"${asset.image_id}"`,
        'X-WQN-Protocol': '3',
        'X-WQN-Request-Id': requestId,
        'X-WQN-Image-Id': asset.image_id,
      },
    });
  } catch {
    return createV3Error(requestId, 500, 'INTERNAL_ERROR', true);
  }
}

export const GET = withV3Security(downloadNoteImage, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

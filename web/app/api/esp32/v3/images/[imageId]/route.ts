import { NextRequest, NextResponse } from 'next/server';
import { deflateSync } from 'zlib';
import {
  createV3Error,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  withV3Security,
} from '@/lib/device-control-v3';
import { authenticateDeviceControlV3 } from '@/lib/device-control-v3-auth';
import {
  DeviceContentArtifactError,
  loadDeviceImageArtifact,
} from '@/lib/device-content-artifacts';
import { createServiceClient } from '@/lib/supabase-utils';

export const runtime = 'nodejs';

async function downloadImage(
  req: NextRequest,
  { params }: { params: Promise<{ imageId: string }> }
) {
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, requestId);
  if (protocolError) return protocolError;
  const auth = await authenticateDeviceControlV3(req, requestId);
  if (auth instanceof NextResponse) return auth;

  const { imageId } = await params;
  try {
    const artifact = await loadDeviceImageArtifact({
      supabase: createServiceClient(),
      userId: auth.userId,
      imageId,
    });
    const deflated = deflateSync(Buffer.from(artifact.body));
    return new NextResponse(new Uint8Array(deflated), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(deflated.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"${imageId}"`,
        'X-WQN-Protocol': '3',
        'X-WQN-Request-Id': requestId,
        'X-WQN-Compression': 'zlib',
        'X-WQN-Image-Id': imageId,
        'X-WQN-Pixel-Format': artifact.pixelFormat,
      },
    });
  } catch (error) {
    if (error instanceof DeviceContentArtifactError) {
      return createV3Error(
        requestId,
        error.status,
        error.code === 'invalid_artifact'
          ? 'INVALID_REQUEST'
          : error.code === 'artifact_not_found'
            ? 'IMAGE_NOT_FOUND'
            : 'ARTIFACT_UNAVAILABLE',
        error.status >= 500,
        error.status >= 500 ? 5000 : undefined
      );
    }
    return createV3Error(requestId, 500, 'ARTIFACT_UNAVAILABLE', true, 5000);
  }
}

export const GET = withV3Security(downloadImage, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

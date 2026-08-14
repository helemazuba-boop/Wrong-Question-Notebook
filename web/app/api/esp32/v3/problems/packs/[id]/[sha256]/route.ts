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
  loadDevicePackArtifact,
} from '@/lib/device-content-artifacts';
import { createServiceClient } from '@/lib/supabase-utils';

export const runtime = 'nodejs';

async function downloadPack(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sha256: string }> }
) {
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, requestId);
  if (protocolError) return protocolError;
  const auth = await authenticateDeviceControlV3(req, requestId);
  if (auth instanceof NextResponse) return auth;

  const { id, sha256 } = await params;
  try {
    const artifact = await loadDevicePackArtifact({
      supabase: createServiceClient(),
      userId: auth.userId,
      domain: 'problem_packs',
      logicalId: id,
      sha256,
    });
    const deflated = deflateSync(Buffer.from(artifact.body));
    return new NextResponse(new Uint8Array(deflated), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(deflated.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"${sha256}"`,
        'X-WQN-Protocol': '3',
        'X-WQN-Request-Id': requestId,
        'X-WQN-Compression': 'zlib',
        'X-WQN-Problem-Pack-Id': id,
        'X-WQN-Problem-Pack-Revision': String(artifact.revision),
        'X-WQN-Problem-Pack-SHA256': sha256,
      },
    });
  } catch (error) {
    if (error instanceof DeviceContentArtifactError) {
      return createV3Error(
        requestId,
        error.status,
        error.status === 410 ? 'SNAPSHOT_EXPIRED' : 'ARTIFACT_UNAVAILABLE',
        error.status >= 500 || error.status === 410,
        error.status >= 500 ? 5000 : undefined
      );
    }
    return createV3Error(requestId, 500, 'ARTIFACT_UNAVAILABLE', true, 5000);
  }
}

export const GET = withV3Security(downloadPack, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

import { NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { FILE_CONSTANTS } from '@/lib/constants';
import { createServiceClient } from '@/lib/supabase-utils';

async function authenticateDevice(req: Request): Promise<{ userId: string } | NextResponse> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      createApiErrorResponse('Missing or invalid Authorization header', 401),
      { status: 401 }
    );
  }

  const token = authHeader.slice(7);
  if (!token) {
    return NextResponse.json(
      createApiErrorResponse('Access token is required', 401),
      { status: 401 }
    );
  }

  const svc = createServiceClient();
  const { data: device } = await svc
    .from('esp32_devices')
    .select('user_id')
    .eq('access_token', token)
    .single();

  if (!device) {
    return NextResponse.json(
      createApiErrorResponse('Invalid access token', 401),
      { status: 401 }
    );
  }

  return { userId: device.user_id };
}

async function getEsp32Asset(req: Request) {
  const authResult = await authenticateDevice(req);
  if (authResult instanceof NextResponse) return authResult;

  const { userId } = authResult;
  const { searchParams } = new URL(req.url);
  const path = searchParams.get('path') || '';
  if (!path) {
    return NextResponse.json(createApiErrorResponse('Asset path is required', 400), {
      status: 400,
    });
  }

  const expectedPrefix = `user/${userId}/`;
  if (!path.startsWith(expectedPrefix) || path.includes('..') || path.includes('\\')) {
    return NextResponse.json(createApiErrorResponse('Invalid asset path', 403), {
      status: 403,
    });
  }

  try {
    const svc = createServiceClient();
    const { data: problemId, error: problemError } = await svc
      .rpc('find_problem_by_asset', { p_path: path })
      .returns<string>()
      .maybeSingle();

    if (problemError) {
      return NextResponse.json(createApiErrorResponse('Failed to verify asset', 500), {
        status: 500,
      });
    }

    if (!problemId) {
      return NextResponse.json(createApiErrorResponse('Asset not found', 404), {
        status: 404,
      });
    }

    const { data: signed, error } = await svc.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .createSignedUrl(path, 300);

    if (error || !signed?.signedUrl) {
      return NextResponse.json(createApiErrorResponse('Asset not found', 404), {
        status: 404,
      });
    }

    return NextResponse.redirect(signed.signedUrl, 302);
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const GET = withSecurity(getEsp32Asset, {
  enableRateLimit: false,
  enableRequestValidation: false,
});

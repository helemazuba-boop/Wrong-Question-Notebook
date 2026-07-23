import { NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import { createApiErrorResponse, handleAsyncError } from '@/lib/common-utils';
import { FILE_CONSTANTS } from '@/lib/constants';
import { createServiceClient } from '@/lib/supabase-utils';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';

async function getEsp32Asset(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { userId } = authResult;
  const { searchParams } = new URL(req.url);
  const path = searchParams.get('path') || '';
  if (!path) {
    return NextResponse.json(
      createApiErrorResponse('Asset path is required', 400),
      {
        status: 400,
      }
    );
  }

  const expectedPrefix = `user/${userId}/`;
  if (
    !path.startsWith(expectedPrefix) ||
    path.includes('..') ||
    path.includes('\\')
  ) {
    return NextResponse.json(
      createApiErrorResponse('Invalid asset path', 403),
      {
        status: 403,
      }
    );
  }

  try {
    const svc = createServiceClient();
    const { data: problemId, error: problemError } = await svc
      .rpc('find_problem_by_asset', { p_path: path })
      .returns<string>()
      .maybeSingle();

    if (problemError) {
      return NextResponse.json(
        createApiErrorResponse('Failed to verify asset', 500),
        {
          status: 500,
        }
      );
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

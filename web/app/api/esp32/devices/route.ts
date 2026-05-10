import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { revalidateUserReviewSchedule } from '@/lib/cache-invalidation';

async function getDevices() {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { data, error } = await supabase
      .from('esp32_devices')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        createApiErrorResponse('Failed to fetch devices', 500),
        { status: 500 }
      );
    }

    return NextResponse.json(
      createApiSuccessResponse({ devices: data || [] })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

async function deleteDevice(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { searchParams } = new URL(req.url);
    const deviceId = searchParams.get('id');

    if (!deviceId) {
      return NextResponse.json(
        createApiErrorResponse('Device ID is required', 400),
        { status: 400 }
      );
    }

    const { error } = await supabase
      .from('esp32_devices')
      .delete()
      .eq('id', deviceId)
      .eq('user_id', user.id);

    if (error) {
      return NextResponse.json(
        createApiErrorResponse('Failed to delete device', 500),
        { status: 500 }
      );
    }

    return NextResponse.json(
      createApiSuccessResponse({ message: 'Device unpaired successfully' })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const GET = withSecurity(getDevices, { rateLimitType: 'readOnly' });
export const DELETE = withSecurity(deleteDevice, { rateLimitType: 'api' });

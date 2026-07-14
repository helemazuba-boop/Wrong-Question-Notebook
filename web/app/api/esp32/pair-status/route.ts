import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';

async function getPairStatus(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();

  const { searchParams } = new URL(req.url);
  const macAddress = searchParams.get('mac_address');

  try {
    const svc = createServiceClient();

    if (macAddress) {
      // Check specific device
      const { data: device } = await svc
        .from('esp32_devices')
        .select('id, mac_address, device_name, created_at, last_seen_at')
        .eq('mac_address', macAddress.toUpperCase())
        .eq('user_id', user.id)
        .single();

      if (device) {
        return NextResponse.json(
          createApiSuccessResponse({
            status: 'paired',
            device,
          })
        );
      }

      const { data: pending } = await svc
        .from('esp32_pairing_pending')
        .select('created_at')
        .eq('mac_address', macAddress.toUpperCase())
        .eq('user_id', user.id)
        .single();

      return NextResponse.json(
        createApiSuccessResponse({
          status: pending ? 'pending' : 'not_found',
          message: pending
            ? 'Pairing request is waiting for device to connect'
            : 'No pairing found for this MAC address',
        })
      );
    }

    // Return all pending for this user
    const { data: pending } = await svc
      .from('esp32_pairing_pending')
      .select('mac_address, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    return NextResponse.json(
      createApiSuccessResponse({
        pending_devices: pending || [],
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const GET = withSecurity(getPairStatus, { rateLimitType: 'readOnly' });

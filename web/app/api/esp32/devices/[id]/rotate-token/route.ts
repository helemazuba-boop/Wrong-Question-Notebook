import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';

// Rotate a device's access token without losing the device name.
//
// /api/esp32/poll is intentionally "never rotate" (it is unauthenticated and
// MAC addresses are not secrets, so rotating there would let anyone who knows
// a MAC hijack the device). Rotation therefore has to happen on an
// authenticated endpoint. Under the existing poll safety model the only way
// for a device to receive a fresh token is to re-pair, so rotation = drop the
// device row (old token dies with it) + re-create the pending pairing row,
// carrying device_name forward. The device's next poll picks up the new token.
async function rotateDeviceToken(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const svc = createServiceClient();

    const { data: device, error: lookupError } = await svc
      .from('esp32_devices')
      .select('id, mac_address, device_name, user_id')
      .eq('id', id)
      .maybeSingle();

    if (lookupError) {
      return NextResponse.json(
        createApiErrorResponse('Failed to look up device', 500),
        { status: 500 }
      );
    }

    if (!device || device.user_id !== user.id) {
      return NextResponse.json(
        createApiErrorResponse('Device not found', 404),
        { status: 404 }
      );
    }

    // Drop the device row so the old token stops authenticating immediately,
    // then queue a re-pair so the device can poll for a fresh token.
    // device_name is carried over via the pending row so the user does not have
    // to rename the device after rotation.
    const { error: deleteError } = await svc
      .from('esp32_devices')
      .delete()
      .eq('id', device.id)
      .eq('user_id', user.id);

    if (deleteError) {
      return NextResponse.json(
        createApiErrorResponse('Failed to rotate token', 500),
        { status: 500 }
      );
    }

    const { error: pendingError } = await svc
      .from('esp32_pairing_pending')
      .upsert(
        {
          mac_address: device.mac_address,
          user_id: user.id,
          device_name: device.device_name || 'ESP32',
        },
        { onConflict: 'mac_address' }
      );

    if (pendingError) {
      // Device row is already gone; the user can recover by pairing again from
      // the web UI. Surface the failure so they know to do that.
      return NextResponse.json(
        createApiErrorResponse(
          'Token rotated but re-pairing could not be queued; pair the device again from the web',
          500
        ),
        { status: 500 }
      );
    }

    return NextResponse.json(
      createApiSuccessResponse({
        status: 'rotated',
        mac_address: device.mac_address,
        message:
          'Token rotated. The device will pick up a new token on its next pairing poll.',
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const POST = withSecurity(rotateDeviceToken, { rateLimitType: 'api' });

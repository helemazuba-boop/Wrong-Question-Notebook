import { NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { randomBytes } from 'crypto';

function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac);
}

async function pollDevice(req: Request) {
  const { searchParams } = new URL(req.url);
  const macAddress = searchParams.get('mac_address');

  if (!macAddress) {
    return NextResponse.json(
      createApiErrorResponse('MAC address is required', 400),
      { status: 400 }
    );
  }

  const normalizedMac = macAddress.trim().toUpperCase();
  if (!isValidMac(normalizedMac)) {
    return NextResponse.json(
      createApiErrorResponse('Invalid MAC address format', 400),
      { status: 400 }
    );
  }

  try {
    const svc = createServiceClient();

    // Check if already paired (return existing token)
    const { data: existingDevice } = await svc
      .from('esp32_devices')
      .select('*')
      .eq('mac_address', normalizedMac)
      .single();

    if (existingDevice) {
      // Update last_seen
      await svc
        .from('esp32_devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('mac_address', normalizedMac);

      return NextResponse.json(
        createApiSuccessResponse({
          status: 'paired',
          access_token: existingDevice.access_token,
          device_name: existingDevice.device_name,
        })
      );
    }

    // Check pending pairing request
    const { data: pending } = await svc
      .from('esp32_pairing_pending')
      .select('user_id, mac_address')
      .eq('mac_address', normalizedMac)
      .single();

    if (!pending) {
      return NextResponse.json(
        createApiSuccessResponse({
          status: 'no_pending',
          message: 'No pairing request found. Please pair from the web first.',
        })
      );
    }

    // Check if pending entry is too old (older than 30 minutes)
    const pendingAge = Date.now() - new Date(pending.created_at).getTime();
    if (pendingAge > 30 * 60 * 1000) {
      await svc.from('esp32_pairing_pending').delete().eq('mac_address', normalizedMac);
      return NextResponse.json(
        createApiSuccessResponse({
          status: 'expired',
          message: 'Pairing request expired. Please pair again from the web.',
        })
      );
    }

    // Complete the pairing
    const accessToken = randomBytes(32).toString('hex');

    const { error: insertError } = await svc.from('esp32_devices').insert({
      mac_address: normalizedMac,
      user_id: pending.user_id,
      access_token: accessToken,
      device_name: 'ESP32',
    });

    if (insertError) {
      return NextResponse.json(
        createApiErrorResponse('Failed to register device', 500),
        { status: 500 }
      );
    }

    // Remove pending entry
    await svc.from('esp32_pairing_pending').delete().eq('mac_address', normalizedMac);

    return NextResponse.json(
      createApiSuccessResponse({
        status: 'paired',
        access_token: accessToken,
        device_name: 'ESP32',
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const GET = withSecurity(pollDevice, { enableRateLimit: false, enableRequestValidation: false });

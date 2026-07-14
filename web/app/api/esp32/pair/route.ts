import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';

function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac);
}

async function pairDevice(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();

  try {
    const body = await req.json();
    const { mac_address, device_name } = body as {
      mac_address?: string;
      device_name?: string;
    };

    if (!mac_address || typeof mac_address !== 'string') {
      return NextResponse.json(
        createApiErrorResponse('MAC address is required', 400),
        { status: 400 }
      );
    }

    const normalizedMac = mac_address.trim().toUpperCase();
    if (!isValidMac(normalizedMac)) {
      return NextResponse.json(
        createApiErrorResponse(
          'Invalid MAC address format. Expected format: AA:BB:CC:DD:EE:FF',
          400
        ),
        { status: 400 }
      );
    }

    const svc = createServiceClient();

    // Check whether this MAC is already registered. MAC addresses are not
    // secrets (broadcast, printed on the device, enumerable), so we must not
    // let one user initiate a pairing/re-pair for a device owned by another
    // account — otherwise the unauthenticated /api/esp32/poll for that MAC
    // would silently reassign ownership to them. The owner must unpair first.
    const { data: existing } = await svc
      .from('esp32_devices')
      .select('id, user_id')
      .eq('mac_address', normalizedMac)
      .maybeSingle();

    if (existing) {
      if (existing.user_id !== user.id) {
        return NextResponse.json(
          createApiErrorResponse(
            'This device is paired to another account. The owner must unpair it first.',
            403
          ),
          { status: 403 }
        );
      }
      return NextResponse.json(
        createApiErrorResponse(
          'This device is already paired to your account',
          409
        ),
        { status: 409 }
      );
    }

    // Upsert pending pairing request. The actual access token is minted later
    // by /api/esp32/poll when the device picks up this request; the pending row
    // only records which user initiated the pair.
    const { error: pendingError } = await svc
      .from('esp32_pairing_pending')
      .upsert(
        {
          mac_address: normalizedMac,
          user_id: user.id,
        },
        { onConflict: 'mac_address' }
      );

    if (pendingError) {
      return NextResponse.json(
        createApiErrorResponse('Failed to create pairing request', 500),
        { status: 500 }
      );
    }

    return NextResponse.json(
      createApiSuccessResponse({
        mac_address: normalizedMac,
        device_name: device_name || 'ESP32',
        status: 'pending',
        message:
          'Pairing request created. Please restart your ESP32 to complete pairing.',
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const POST = withSecurity(pairDevice, { rateLimitType: 'api' });

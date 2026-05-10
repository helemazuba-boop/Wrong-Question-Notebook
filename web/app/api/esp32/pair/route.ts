import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
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

async function pairDevice(req: Request) {
  const { user, supabase } = await requireUser();
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

    // Check if already paired
    const { data: existing } = await svc
      .from('esp32_devices')
      .select('id, access_token')
      .eq('mac_address', normalizedMac)
      .eq('user_id', user.id)
      .single();

    if (existing) {
      return NextResponse.json(
        createApiErrorResponse('This device is already paired to your account', 409),
        { status: 409 }
      );
    }

    // Generate a secure access token
    const accessToken = randomBytes(32).toString('hex');

    // Upsert pending pairing request
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
        message: 'Pairing request created. Please restart your ESP32 to complete pairing.',
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

import { NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { randomBytes } from 'crypto';
import { hashDeviceToken } from '@/lib/esp32-token';

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

    // MAC alone is not a secret. Never echo an existing access_token just
    // because a caller claims a known MAC. A token is only minted when there
    // is a matching pending pairing record that an authenticated web user has
    // just created via POST /api/esp32/pair.
    const [existingResult, pendingResult] = await Promise.all([
      svc
        .from('esp32_devices')
        .select('id, user_id, device_name')
        .eq('mac_address', normalizedMac)
        .maybeSingle(),
      svc
        .from('esp32_pairing_pending')
        .select('user_id, mac_address, created_at, device_name')
        .eq('mac_address', normalizedMac)
        .maybeSingle(),
    ]);

    if (existingResult.error || pendingResult.error) {
      return NextResponse.json(
        createApiErrorResponse('Failed to check pairing state', 500),
        { status: 500 }
      );
    }

    const existingDevice = existingResult.data;
    const pending = pendingResult.data;

    if (existingDevice) {
      // The device is already registered. This endpoint is unauthenticated and
      // MACs are not secrets, so we must NEVER silently rotate the token or
      // reassign ownership here — otherwise anyone who knows a MAC could
      // hijack a device. The owner must unpair from the web first. We still
      // bump last_seen so the web UI shows liveness.
      await svc
        .from('esp32_devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', existingDevice.id);

      // Drop any stray pending request for this MAC (e.g. a leftover from a
      // blocked cross-user pair attempt) so it does not linger until expiry.
      if (pending) {
        await svc
          .from('esp32_pairing_pending')
          .delete()
          .eq('mac_address', normalizedMac);
      }

      return NextResponse.json(
        createApiSuccessResponse({
          status: 'already_paired',
          device_name: existingDevice.device_name,
          message:
            'Device is already paired. Unpair from the web before requesting a new token.',
        })
      );
    }

    if (!pending) {
      return NextResponse.json(
        createApiSuccessResponse({
          status: 'no_pending',
          message: 'No pairing request found. Please pair from the web first.',
        })
      );
    }

    // Check if pending entry is too old (older than 30 minutes)
    const pendingCreatedAt = pending.created_at
      ? new Date(pending.created_at)
      : new Date(0);
    const pendingAge = Date.now() - pendingCreatedAt.getTime();
    if (pendingAge > 30 * 60 * 1000) {
      await svc
        .from('esp32_pairing_pending')
        .delete()
        .eq('mac_address', normalizedMac);
      return NextResponse.json(
        createApiSuccessResponse({
          status: 'expired',
          message: 'Pairing request expired. Please pair again from the web.',
        })
      );
    }

    // Complete first-time pairing for a brand-new device. An existing device
    // row is handled by the early return above (which always requires an
    // unpair first), so we only ever INSERT here — we never rotate a token or
    // reassign ownership from this unauthenticated endpoint.
    const accessToken = randomBytes(32).toString('hex');

    const { error: insertError } = await svc.from('esp32_devices').insert({
      mac_address: normalizedMac,
      user_id: pending.user_id,
      access_token_hash: hashDeviceToken(accessToken),
      device_name: pending.device_name || 'ESP32',
    });

    if (insertError) {
      return NextResponse.json(
        createApiErrorResponse('Failed to register device', 500),
        { status: 500 }
      );
    }

    // Remove pending entry
    await svc
      .from('esp32_pairing_pending')
      .delete()
      .eq('mac_address', normalizedMac);

    return NextResponse.json(
      createApiSuccessResponse({
        status: 'paired',
        access_token: accessToken,
        device_name: pending.device_name || 'ESP32',
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

// /poll is unauthenticated, but the firmware polls every 2 s for up to a
// 2-minute pairing window, so the bucket has to be sized for a real device.
// 'auth' (5 req / 15 min) was far too tight and made every retry burst hit
// HTTP 429. Use the dedicated 'esp32Poll' bucket (180 req / 5 min, IP-keyed)
// which still deters MAC enumeration but lets a single device finish pairing.
// Request validation stays off because ESP32 firmware sends a minimal header
// set.
export const GET = withSecurity(pollDevice, {
  rateLimitType: 'esp32Poll',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});

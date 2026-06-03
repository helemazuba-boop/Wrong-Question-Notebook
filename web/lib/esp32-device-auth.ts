import { NextResponse } from 'next/server';
import { createApiErrorResponse } from '@/lib/common-utils';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';

export interface Esp32DeviceAuthContext {
  userId: string;
  deviceId: string;
  macAddress: string;
}

export interface Esp32DeviceAuthOptions {
  updateLastSeen?: boolean;
}

const BEARER_PREFIX = 'Bearer ';

export function createEsp32DeviceUnauthorizedResponse(
  message = 'Unauthorized'
): NextResponse {
  const apiError = createApiErrorResponse(message, 401, {
    code: 'unauthorized',
  });

  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'unauthorized',
        message: apiError.error,
      },
      status: apiError.status,
      timestamp: apiError.timestamp,
    },
    { status: 401 }
  );
}

export async function authenticateEsp32Device(
  req: Request,
  options: Esp32DeviceAuthOptions = {}
): Promise<Esp32DeviceAuthContext | NextResponse> {
  const { updateLastSeen = true } = options;
  const authHeader = req.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return createEsp32DeviceUnauthorizedResponse(
      'Missing or invalid Authorization header'
    );
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    return createEsp32DeviceUnauthorizedResponse('Access token is required');
  }

  const svc = createServiceClient();
  const { data: device, error } = await svc
    .from('esp32_devices')
    .select('id, user_id, mac_address')
    .eq('access_token', token)
    .maybeSingle();

  if (error) {
    logger.error('ESP32 device auth lookup failed', error, {
      component: 'ESP32DeviceAuth',
      action: 'lookup',
    });
    return NextResponse.json(
      createApiErrorResponse('Failed to authenticate device', 500),
      { status: 500 }
    );
  }

  if (!device) {
    return createEsp32DeviceUnauthorizedResponse('Invalid access token');
  }

  if (updateLastSeen) {
    const { error: updateError } = await svc
      .from('esp32_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', device.id);

    if (updateError) {
      logger.warn('ESP32 device last_seen update failed', {
        component: 'ESP32DeviceAuth',
        action: 'updateLastSeen',
        deviceId: device.id,
      });
    }
  }

  return {
    userId: device.user_id,
    deviceId: device.id,
    macAddress: device.mac_address,
  };
}

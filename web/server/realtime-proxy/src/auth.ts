/**
 * auth.ts — Bearer token → DeviceContext resolver.
 *
 * Mirrors web/lib/esp32-device-auth.ts::authenticateEsp32Device but is
 * decoupled from NextRequest/NextResponse so it can run inside this Bun
 * server. Returns DeviceContext on success, throws a relay error on
 * failure (caller decides close code).
 *
 * IMPORTANT: `request` is the raw Request from `fetch upgrade`. We never
 * trust the client's `x-forwarded-for` here because nginx forwards
 * 127.0.0.1 → this server; the device IP is opaque to us.
 */

import type { IncomingMessage } from 'node:http';
import { createHash } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { log } from './logger.ts';
import { makeError, type DeviceContext, type RelayErrorCode } from './types.ts';

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabase;
}

const BEARER_PREFIX = 'Bearer ';
const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export class AuthFailure extends Error {
  constructor(
    public readonly code: RelayErrorCode,
    message: string
  ) {
    super(message);
  }
  toPayload() {
    return makeError(this.code, this.message, 'auth');
  }
}

export async function authenticateDevice(
  req: IncomingMessage
): Promise<DeviceContext> {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new AuthFailure(
      'unauthorized',
      'Missing or invalid Authorization header'
    );
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!DEVICE_TOKEN_PATTERN.test(token)) {
    throw new AuthFailure('unauthorized', 'Invalid access token');
  }

  const svc = getSupabase();
  const { data: device, error } = await svc
    .from('esp32_devices')
    .select('id, user_id, mac_address')
    .eq('access_token_hash', createHash('sha256').update(token).digest('hex'))
    .maybeSingle();

  if (error) {
    log.error('device auth lookup failed', { err: error.message });
    throw new AuthFailure('internal', 'Failed to authenticate device');
  }
  if (!device) {
    throw new AuthFailure('unauthorized', 'Invalid access token');
  }

  // best-effort last_seen bump — don't fail the connection if it errors
  svc
    .from('esp32_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id)
    .then(({ error: updateErr }) => {
      if (updateErr)
        log.warn('last_seen update failed', { deviceId: device.id });
    });

  return {
    userId: device.user_id,
    deviceId: device.id,
    macAddress: device.mac_address,
  };
}

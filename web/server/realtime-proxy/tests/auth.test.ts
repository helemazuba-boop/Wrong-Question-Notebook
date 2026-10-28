import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { TEST_USER } from '@/lib/test/supabase-query';
import { authenticateDevice } from '@/server/realtime-proxy/src/auth';

// Mock the HTTP boundary, not an SDK module ID: the relay has its own locked
// Supabase installation, which may differ from the Web package's instance.
const device = { id: 'device', user_id: TEST_USER.id, mac_address: 'AA' };
const request = {
  headers: { authorization: `Bearer ${'a'.repeat(64)}` },
} as IncomingMessage;
let profile: unknown;
let knownDevice: boolean;
let statusError: 'response' | 'abort' | null;
const calls: { url: URL; method: string; signal?: AbortSignal | null }[] = [];

beforeEach(() => {
  profile = { is_active: true };
  knownDevice = true;
  statusError = null;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');
      calls.push({ url, method, signal: init?.signal });
      if (url.origin !== 'https://supabase.example.invalid') {
        throw new Error('Unmocked network request');
      }
      if (url.pathname === '/rest/v1/user_profiles') {
        if (statusError === 'abort')
          throw new DOMException('offline', 'AbortError');
        return new Response(
          JSON.stringify(
            statusError === 'response'
              ? { message: 'offline', code: '42501' }
              : profile === null
                ? []
                : [profile]
          ),
          {
            status: statusError === 'response' ? 403 : 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      if (url.pathname === '/rest/v1/esp32_devices') {
        if (method === 'PATCH') return new Response(null, { status: 204 });
        return new Response(JSON.stringify(knownDevice ? [device] : []), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('Unmocked network request');
    })
  );
  vi.stubEnv('SUPABASE_URL', 'https://supabase.example.invalid');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'local-test-only');
  vi.stubEnv('WQN_SUPABASE_EXPECTED_HOST', 'supabase.example.invalid');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const writes = () => calls.filter(call => call.method !== 'GET');

describe('realtime device account gate', () => {
  it('forwards the upgrade deadline signal through both authoritative lookups', async () => {
    const controller = new AbortController();
    await expect(
      authenticateDevice(request, controller.signal)
    ).resolves.toMatchObject({ deviceId: device.id });
    const lookups = calls.filter(call => call.method === 'GET');
    expect(lookups).toHaveLength(2);
    expect(lookups.every(call => call.signal === controller.signal)).toBe(true);
  });
  it.each([false, null, 'unavailable'])(
    'rejects state %s before provider dispatch or usage update',
    async state => {
      profile = state === null ? null : { is_active: state };
      statusError = state === 'unavailable' ? 'response' : null;
      await expect(authenticateDevice(request)).rejects.toMatchObject({
        code: state === 'unavailable' ? 'internal' : 'disabled',
      });
      expect(calls).toHaveLength(2);
      expect(calls[1].url.searchParams.get('id')).toBe(`eq.${TEST_USER.id}`);
      expect(writes()).toEqual([]);
    }
  );
  it('does not turn an aborted status lookup into invalid pairing', async () => {
    statusError = 'abort';
    await expect(authenticateDevice(request)).rejects.toMatchObject({
      code: 'internal',
    });
    expect(writes()).toEqual([]);
  });
  it('allows an active paired owner and preserves the device context', async () => {
    await expect(authenticateDevice(request)).resolves.toEqual({
      userId: device.user_id,
      deviceId: device.id,
      macAddress: device.mac_address,
    });
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].method).toBe('PATCH');
    expect(writes()[0].url.searchParams.get('id')).toBe(`eq.${device.id}`);
  });
  it('keeps unknown tokens distinct from disabled accounts', async () => {
    knownDevice = false;
    await expect(authenticateDevice(request)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(calls).toHaveLength(1);
    expect(writes()).toEqual([]);
  });
});

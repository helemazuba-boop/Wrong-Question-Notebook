import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mocks.from }),
}));
import { authenticateDevice } from '@/server/realtime-proxy/src/auth';

const device = { id: 'device', user_id: TEST_USER.id, mac_address: 'AA' };
const request = {
  headers: { authorization: `Bearer ${'a'.repeat(64)}` },
} as IncomingMessage;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
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

describe('realtime device account gate', () => {
  it.each([false, null, 'unavailable'])(
    'rejects state %s before provider dispatch or usage update',
    async state => {
      const credential = queryResult(device);
      const profile = queryResult(
        state === null ? null : { is_active: state },
        state === 'unavailable' ? { message: 'offline' } : null
      );
      mocks.from.mockImplementation(table =>
        table === 'user_profiles' ? profile : credential
      );
      await expect(authenticateDevice(request)).rejects.toMatchObject({
        code: state === 'unavailable' ? 'internal' : 'disabled',
      });
      expect(profile.eq).toHaveBeenCalledWith('id', TEST_USER.id);
      expect(credential.update).not.toHaveBeenCalled();
      expect(credential.delete).not.toHaveBeenCalled();
    }
  );
  it('does not turn a thrown status lookup into invalid pairing', async () => {
    mocks.from.mockImplementation(table => {
      if (table === 'user_profiles') throw new Error('offline');
      return queryResult(device);
    });
    await expect(authenticateDevice(request)).rejects.toMatchObject({
      code: 'internal',
    });
  });
  it('allows an active paired owner and preserves the device context', async () => {
    const credential = queryResult(device);
    mocks.from.mockImplementation(table =>
      table === 'user_profiles' ? queryResult({ is_active: true }) : credential
    );
    await expect(authenticateDevice(request)).resolves.toEqual({
      userId: TEST_USER.id,
      deviceId: device.id,
      macAddress: device.mac_address,
    });
    expect(credential.update).toHaveBeenCalledOnce();
  });
  it('keeps unknown tokens distinct from disabled accounts', async () => {
    mocks.from.mockReturnValue(queryResult());
    await expect(authenticateDevice(request)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
});

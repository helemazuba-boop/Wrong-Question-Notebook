import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
import { authenticateDeviceControlV3 } from '@/lib/device-control-v3-auth';
import { POST as sync } from '@/app/api/esp32/v3/sync/route';

const device = {
  id: 'device',
  user_id: TEST_USER.id,
  hardware_id: 'hardware',
  mac_address: 'AA',
  config_revision: 4,
  sync_cursor: 3,
  auto_sync_interval_minutes: 60,
};
const requestId = 'req_account_status_0001';
function request(token = 'a'.repeat(64)) {
  return new NextRequest('https://example.test/api/esp32/v3/sync', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-WQN-Protocol': '3',
      'X-WQN-Request-Id': requestId,
    },
    body: '{}',
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  _resetRateLimitStore();
});

describe('v3 current-account credential gate', () => {
  it.each([false, null, 'unavailable'])(
    'rejects owner state %s before replay or endpoint work',
    async state => {
      const credential = queryResult(device);
      const profile = queryResult(
        state === null ? null : { is_active: state },
        state === 'unavailable' ? { message: 'offline' } : null
      );
      mocks.from.mockImplementation(table =>
        table === 'user_profiles' ? profile : credential
      );
      const response = await sync(request());
      expect(response.status).toBe(state === 'unavailable' ? 503 : 403);
      expect(await response.json()).toMatchObject({
        ok: false,
        request_id: requestId,
        error: {
          code:
            state === 'unavailable'
              ? 'AUTH_SERVICE_UNAVAILABLE'
              : 'ACCOUNT_DISABLED',
          retryable: true,
        },
      });
      expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
        'esp32_devices',
        'user_profiles',
      ]);
      expect(profile.eq).toHaveBeenCalledWith('id', TEST_USER.id);
      expect(credential.update).not.toHaveBeenCalled();
      expect(credential.delete).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );
  it('returns retryable 503 if the status lookup throws', async () => {
    mocks.from.mockImplementation(table => {
      if (table === 'user_profiles') throw new Error('offline');
      return queryResult(device);
    });
    const response = await authenticateDeviceControlV3(request(), requestId);
    expect(response).toHaveProperty('status', 503);
  });
  it('permits reactivation with the same device token and unchanged context', async () => {
    let active = false;
    mocks.from.mockImplementation(table =>
      queryResult(table === 'user_profiles' ? { is_active: active } : device)
    );
    expect(
      await authenticateDeviceControlV3(request(), requestId)
    ).toHaveProperty('status', 403);
    active = true;
    expect(await authenticateDeviceControlV3(request(), requestId)).toEqual({
      userId: TEST_USER.id,
      deviceId: device.id,
      hardwareId: device.hardware_id,
      configRevision: 4,
      syncCursor: 3,
      autoSyncIntervalMinutes: 60,
    });
  });
  it.each(['', 'invalid'])(
    'keeps malformed token %s as 401 without database work',
    async token => {
      expect(
        await authenticateDeviceControlV3(request(token), requestId)
      ).toHaveProperty('status', 401);
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );
  it('keeps unknown tokens as 401 without an account query', async () => {
    mocks.from.mockReturnValue(queryResult());
    expect(
      await authenticateDeviceControlV3(request(), requestId)
    ).toHaveProperty('status', 401);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
  it('keeps token lookup failures retryable and distinct from invalid credentials', async () => {
    mocks.from.mockReturnValue(queryResult(null, { message: 'offline' }));
    expect(
      await authenticateDeviceControlV3(request(), requestId)
    ).toHaveProperty('status', 503);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mocks.from }),
}));
import { authenticateMcpRequest } from '@/lib/api-token-auth';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SITE_URL = 'https://example.test';
});
describe('service credential account status', () => {
  it.each([false, null, 'unavailable'])(
    'rejects a personal token for account status %s before touching usage',
    async state => {
      const token = queryResult({ id: 'token', user_id: TEST_USER.id });
      const profile = queryResult(
        state === null ? null : { is_active: state },
        state === 'unavailable' ? { message: 'offline' } : null
      );
      mocks.from.mockImplementation(table =>
        table === 'user_profiles' ? profile : token
      );
      const result = await authenticateMcpRequest(
        new Request('https://example.test/api/mcp', {
          headers: { Authorization: `Bearer wqn_mcp_${'a'.repeat(64)}` },
        })
      );
      expect(result).toHaveProperty(
        'status',
        state === 'unavailable' ? 503 : 403
      );
      expect(token.update).not.toHaveBeenCalled();
      expect(profile.eq).toHaveBeenCalledWith('id', TEST_USER.id);
    }
  );
  it('preserves device pairing on account disablement', async () => {
    const device = queryResult({
      id: 'device',
      user_id: TEST_USER.id,
      mac_address: 'AA',
    });
    mocks.from.mockImplementation(table =>
      table === 'user_profiles' ? queryResult({ is_active: false }) : device
    );
    const result = await authenticateEsp32Device(
      new Request('https://example.test/api/esp32', {
        headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
      })
    );
    expect(result).toHaveProperty('status', 403);
    expect(device.update).not.toHaveBeenCalled();
  });
});

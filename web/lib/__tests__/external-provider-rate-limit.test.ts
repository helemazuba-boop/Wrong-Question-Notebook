import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc }),
}));

import { acquireExternalProviderRateLimit } from '@/lib/external-provider-rate-limit';

beforeEach(() => vi.clearAllMocks());

describe('external provider rate limit', () => {
  it('delegates the reservation to the atomic database RPC', async () => {
    rpc.mockResolvedValue({
      data: {
        allowed: true,
        current_count: 3,
        limit: 10,
        retry_after_ms: 400,
      },
      error: null,
    });

    await expect(
      acquireExternalProviderRateLimit('ai-extraction:google', 10, 1)
    ).resolves.toMatchObject({ allowed: true, current_count: 3 });
    expect(rpc).toHaveBeenCalledWith('acquire_external_provider_rate_limit', {
      p_scope: 'ai-extraction:google',
      p_max_requests: 10,
      p_window_seconds: 1,
    });
  });

  it('fails closed when the durable limiter is unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
    await expect(
      acquireExternalProviderRateLimit('ai-extraction:google', 10, 1)
    ).rejects.toThrow('Failed to reserve provider capacity');
  });
});

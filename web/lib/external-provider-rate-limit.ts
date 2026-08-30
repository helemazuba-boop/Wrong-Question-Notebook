import { createServiceClient } from '@/lib/supabase-utils';

export interface ExternalProviderRateLimitResult {
  allowed: boolean;
  current_count: number;
  limit: number;
  retry_after_ms: number;
}

/**
 * Atomically reserve provider capacity in a database-backed fixed window.
 * This deliberately uses the service role; browser roles have no access to
 * either the table or the RPC.
 */
export async function acquireExternalProviderRateLimit(
  scope: string,
  maximum: number,
  windowSeconds: number
): Promise<ExternalProviderRateLimitResult> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc(
    'acquire_external_provider_rate_limit',
    {
      p_scope: scope,
      p_max_requests: maximum,
      p_window_seconds: windowSeconds,
    }
  );

  if (error) {
    console.error('External provider rate-limit check failed:', error);
    throw new Error('Failed to reserve provider capacity');
  }

  return data as unknown as ExternalProviderRateLimitResult;
}

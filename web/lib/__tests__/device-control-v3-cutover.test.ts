import { describe, expect, it } from 'vitest';
import { POST as legacyPair } from '@/app/api/esp32/pair/route';
import { GET as legacyPairStatus } from '@/app/api/esp32/pair-status/route';
import { GET as legacyPoll } from '@/app/api/esp32/poll/route';
import { POST as legacySync } from '@/app/api/esp32/sync/route';
import {
  GET as legacyWordReviewQueue,
  POST as legacyWordReviewWrite,
} from '@/app/api/esp32/words/review/route';
import { GET as legacyWordSync } from '@/app/api/esp32/words/sync/route';

describe('device-control v3 synchronized cutover', () => {
  const routes = [
    ['pair', 'POST', legacyPair],
    ['pair-status', 'GET', legacyPairStatus],
    ['poll', 'GET', legacyPoll],
    ['sync', 'POST', legacySync],
    ['words/review', 'GET', legacyWordReviewQueue],
    ['words/review', 'POST', legacyWordReviewWrite],
    ['words/sync', 'GET', legacyWordSync],
  ] as const;

  for (const [name, method, handler] of routes) {
    it(`rejects the legacy ${name} control route with an explicit upgrade`, async () => {
      const requestId = `legacy_${name.replace(/[^a-z0-9]+/g, '_')}_0001`;
      const response = await handler(
        new Request(`https://wqn.helema.cn/api/esp32/${name}`, {
          method,
          headers: { 'X-WQN-Request-Id': requestId },
        })
      );

      expect(response.status).toBe(426);
      expect(response.headers.get('X-WQN-Protocol')).toBe('3');
      await expect(response.json()).resolves.toEqual({
        ok: false,
        request_id: requestId,
        error: { code: 'UPGRADE_REQUIRED', retryable: false },
      });
    });
  }
});

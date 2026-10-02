import 'server-only';

import { after } from 'next/server';
import { runWordProjectionBatch } from '@/lib/word-progress-projector';

// Best-effort prompt projection after a word study observation. The observation
// already marked the timeline dirty in the same transaction, so this drains the
// queue immediately instead of waiting for the cron backstop.
//
// It runs post-response and swallows every error. Registering the callback is
// guarded too: `after()` needs a request scope, and a word observation must
// never fail because the projection wake-up could not be scheduled — the
// observation itself is already durable.
export function wakeWordProgressProjection(): void {
  try {
    after(async () => {
      try {
        await runWordProjectionBatch({
          limit: 5,
          leaseSeconds: 120,
          concurrency: 1,
        });
      } catch (error) {
        console.error(
          '[word-progress-projector] best-effort wake failed:',
          error
        );
      }
    });
  } catch (error) {
    console.error('[word-progress-projector] wake registration failed:', error);
  }
}

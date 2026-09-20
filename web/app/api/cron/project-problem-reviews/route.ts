import { NextResponse } from 'next/server';
import { runProjectionBatch } from '@/lib/fsrs/projector';
import { createServiceClient } from '@/lib/supabase-utils';
import { WordSchedulerSeedResultSchema } from '@/lib/word-progress-projector-contract';
import { runWordProjectionBatch } from '@/lib/word-progress-projector';
import { getWordReviewAlgorithm } from '@/lib/word-scheduler-selection';

interface BatchCounters {
  claimed: number;
  committed: number;
  stale: number;
  failed: number;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// The deployment default only applies to users without a scheduler row, and the
// RPC refuses to seed anyone whose reviewed words are not projected yet, so a
// flipped WORD_REVIEW_ALGORITHM cannot promote a stale shadow.
async function seedWordSchedulerDefault(): Promise<{
  inserted: number;
  authority_mode: string;
}> {
  const { data, error } = await createServiceClient().rpc(
    'seed_word_scheduler_settings',
    { p_default_authority_mode: getWordReviewAlgorithm() }
  );
  if (error) throw error;
  return WordSchedulerSeedResultSchema.parse(data);
}

// One cron drains both review queues and applies the word scheduler default.
// Each step is independent: a broken word projection must not stop problem
// reviews from committing, and the response still carries the counters the host
// log scrape looks for.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    req.headers.get('authorization') !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const problems = await attempt(() =>
    runProjectionBatch({
      limit: 20,
      leaseSeconds: 180,
      concurrency: 3,
    })
  );
  const words = await attempt(() =>
    runWordProjectionBatch({
      limit: 20,
      leaseSeconds: 180,
      concurrency: 3,
    })
  );
  const seed = await attempt(seedWordSchedulerDefault);

  const failed = !problems.ok || !words.ok || !seed.ok;
  const emptyBatch: BatchCounters = {
    claimed: 0,
    committed: 0,
    stale: 0,
    failed: 0,
  };

  return NextResponse.json(
    {
      ...(problems.ok
        ? problems.value
        : { ...emptyBatch, error: problems.error }),
      words: words.ok ? words.value : { ...emptyBatch, error: words.error },
      // The host log scrape greps the response for "failed":[1-9]. The word
      // batch already lands there through words.failed; giving the seed step
      // its own counter keeps a seeding error from showing up only as a 500
      // beside a flat problem counter.
      seed: seed.ok ? seed.value : { failed: 1, error: seed.error },
    },
    { status: failed ? 500 : 200 }
  );
}

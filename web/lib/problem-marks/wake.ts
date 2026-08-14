import 'server-only';

import { after } from 'next/server';
import { annotateProblemMarks } from '@/lib/problem-marks/annotate';
import { createServiceClient } from '@/lib/supabase-utils';

// Best-effort prompt annotation after an objective Problem write. The enqueue
// trigger has already created the annotation head in the same transaction, so
// this processes it promptly instead of waiting for the cron drain. It runs
// post-response and swallows every error — the bounded cron worker is the
// durable backstop.
export function wakeProblemMarkAnnotation(problemId: string): void {
  after(async () => {
    try {
      await annotateProblemMarks(createServiceClient(), problemId);
    } catch (error) {
      console.error(
        '[problem-mark-annotation] best-effort wake failed:',
        error
      );
    }
  });
}

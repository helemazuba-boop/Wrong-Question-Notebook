import { createServiceClient } from '@/lib/supabase-utils';
import {
  ProblemMarksQueueClient,
  type ProblemMarkQueueHealth,
} from '@/components/admin/problem-marks/problem-marks-queue-client';

export const dynamic = 'force-dynamic';

export default async function AdminProblemMarksPage() {
  const supabase = createServiceClient();
  const { data } = await supabase.rpc('problem_mark_annotation_health');

  return (
    <ProblemMarksQueueClient
      initialHealth={(data ?? null) as ProblemMarkQueueHealth | null}
    />
  );
}

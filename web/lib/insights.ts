import { INSIGHT_CONSTANTS } from '@/lib/constants';
import type { InsightDigest } from '@/lib/types';

export interface InsightReportData {
  digest: InsightDigest | null;
  isGenerating: boolean;
  subjects: Array<{ id: string; name: string; color: string | null }>;
}

export async function loadInsightReportData(
  supabase: any,
  userId: string
): Promise<InsightReportData> {
  const { data: latestRow } = await supabase
    .from('insight_digests')
    .select('*')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let isGenerating = false;
  let digest = latestRow as InsightDigest | null;

  if (latestRow?.status === 'generating') {
    const staleThreshold = new Date(
      Date.now() - INSIGHT_CONSTANTS.GENERATING_STALE_MINUTES * 60 * 1000
    );
    const generatedAt = new Date(latestRow.generated_at);

    if (generatedAt < staleThreshold) {
      digest = null;
    } else {
      isGenerating = true;
      digest = null;
    }
  } else if (latestRow?.status === 'failed') {
    digest = null;
  }

  const { data: subjects } = await supabase
    .from('subjects')
    .select('id, name, color')
    .eq('user_id', userId);

  return {
    digest,
    isGenerating,
    subjects: subjects || [],
  };
}

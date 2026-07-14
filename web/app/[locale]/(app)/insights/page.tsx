import { requireUser } from '@/lib/supabase/requireUser';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { loadInsightReportData } from '@/lib/insights';
import InsightsPageClient from './insights-page-client';

export async function generateMetadata() {
  const t = await getTranslations('Metadata');
  return { title: t('statisticsMetaTitle') };
}

export default async function InsightsPage() {
  const { user } = await requireUser();
  if (!user) redirect('/auth/login?redirect=/insights');

  const supabase = await createClient();
  const data = await loadInsightReportData(supabase, user.id);

  return (
    <InsightsPageClient
      initialDigest={data.digest}
      initialIsGenerating={data.isGenerating}
      subjects={data.subjects}
    />
  );
}

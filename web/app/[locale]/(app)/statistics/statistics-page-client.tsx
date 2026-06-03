'use client';

import { FileQuestion, Trophy, Flame, Clock, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { InsightDigest, StatisticsData } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { HeroStatCard } from '@/components/statistics/hero-stat-card';
import { StatusDoughnutChart } from '@/components/statistics/status-doughnut-chart';
import { SubjectBarChart } from '@/components/statistics/subject-bar-chart';
import { SubjectRadarChart } from '@/components/statistics/subject-radar-chart';
import { ProgressLineChart } from '@/components/statistics/progress-line-chart';
import { ActivityHeatmap } from '@/components/statistics/activity-heatmap';
import { RecentActivityFeedUser } from '@/components/statistics/recent-activity-feed-user';
import { formatDuration } from '@/lib/common-utils';
import InsightsPageClient from '../insights/insights-page-client';

interface StatisticsPageClientProps {
  data: StatisticsData;
  insightDigest: InsightDigest | null;
  insightIsGenerating: boolean;
  insightSubjects: Array<{ id: string; name: string; color: string | null }>;
}

export default function StatisticsPageClient({
  data,
  insightDigest,
  insightIsGenerating,
  insightSubjects,
}: StatisticsPageClientProps) {
  const t = useTranslations('Statistics');
  const { overview, streaks, sessionStats, subjectBreakdown } = data;

  return (
    <div className="section-container">
      <PageHeader title={t('title')} description={t('subtitle')} />

      <section className="space-y-5" aria-labelledby="study-report-overview">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 id="study-report-overview" className="text-lg font-semibold">
              {t('reportOverview')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('reportOverviewDesc')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <HeroStatCard
            icon={FileQuestion}
            value={overview.total_problems}
            label={t('totalProblems')}
            color="amber"
          />
          <HeroStatCard
            icon={Trophy}
            value={`${overview.mastery_rate}%`}
            label={t('masteryRate')}
            sublabel={t('masteredProblems', { count: overview.mastered_count })}
            color="emerald"
          />
          <HeroStatCard
            icon={Flame}
            value={streaks.current_streak}
            label={t('dayStreak')}
            sublabel={`${t('bestStreak', { count: streaks.longest_streak })}`}
            color="orange"
          />
          <HeroStatCard
            icon={Clock}
            value={
              sessionStats.total_review_time_ms > 0
                ? formatDuration(sessionStats.total_review_time_ms)
                : '0:00'
            }
            label={t('totalReviewTime')}
            sublabel={`${sessionStats.total_sessions} ${t('sessions')}`}
            color="rose"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-5 stats-bento-card min-h-[300px]">
            <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-3">
              {t('statusDistribution')}
            </h3>
            <StatusDoughnutChart overview={overview} />
          </div>
          <div className="lg:col-span-7 stats-bento-card min-h-[300px]">
            <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-3">
              {t('notebookBreakdown')}
            </h3>
            <div className="h-[250px]">
              <SubjectBarChart data={subjectBreakdown} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 stats-bento-card min-h-[300px]">
            <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-3">
              {t('masteryProgress')}
            </h3>
            <div className="h-[250px]">
              <ProgressLineChart data={data.weeklyProgress} />
            </div>
          </div>
          <div className="lg:col-span-5 stats-bento-card min-h-[300px]">
            <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-3">
              {t('masteryRadar')}
            </h3>
            <div className="h-[250px]">
              <SubjectRadarChart data={subjectBreakdown} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7">
            <ActivityHeatmap
              data={data.activityHeatmap}
              timezone={data.timezone}
            />
          </div>
          <div className="lg:col-span-5 relative">
            <div className="lg:absolute lg:inset-0">
              <RecentActivityFeedUser activities={data.recentActivity} />
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-5" aria-labelledby="study-report-ai">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:bg-orange-500/20 dark:text-orange-300">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h2 id="study-report-ai" className="text-lg font-semibold">
              {t('aiAnalysis')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('aiAnalysisDesc')}
            </p>
          </div>
        </div>
        <InsightsPageClient
          initialDigest={insightDigest}
          initialIsGenerating={insightIsGenerating}
          subjects={insightSubjects}
          embedded
        />
      </section>
    </div>
  );
}

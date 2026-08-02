import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { loadWordDecks } from '@/lib/words';
import {
  loadWordProgressOverview,
  type WebWordProgressOverview,
} from '@/lib/word-study-web';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Word 学习进度' };
}

function formatDate(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function actionLabel(action: string) {
  if (action === 'known') return '认识';
  if (action === 'unknown') return '不认识';
  if (action === 'skipped') return '跳过';
  if (action === 'looked_up') return '查阅';
  return action;
}

function ProgressCards({ overview }: { overview: WebWordProgressOverview }) {
  const cards = [
    ['词条总数', overview.totals.total],
    ['今日到期', overview.totals.due_count],
    ['学习中', overview.totals.learning_count + overview.totals.review_count],
    ['已掌握', overview.totals.mastered_count],
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, value]) => (
        <Card key={String(label)}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              {label}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{value}</CardContent>
        </Card>
      ))}
    </div>
  );
}

export default async function WordProgressPage() {
  const { user, supabase } = await requireUser();
  if (!user) redirect('/auth/login?redirect=/words/progress');

  const decks = await loadWordDecks(supabase, user.id, {
    includeSystem: true,
    limit: 100,
  });
  const overview = await loadWordProgressOverview(
    createServiceClient(),
    user.id,
    decks.map(deck => deck.id)
  );
  const deckTitleById = new Map(decks.map(deck => [deck.id, deck.title]));

  return (
    <div className="section-container space-y-6">
      <PageHeader
        title="Word 学习进度"
        description="Web、MCP 与 WQN Note4 共用同一份词条进度；这里展示已经确认写入云端的结果。"
        actions={
          <Link className="text-sm text-primary hover:underline" href="/words">
            返回词库
          </Link>
        }
      />
      <ProgressCards overview={overview} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>各词库状态</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.decks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                还没有可统计的词库。
              </p>
            ) : (
              overview.decks.map(summary => (
                <Link
                  key={summary.deck_id}
                  href={`/words/decks/${summary.deck_id}`}
                  className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/40"
                >
                  <div>
                    <p className="font-medium">
                      {deckTitleById.get(summary.deck_id) || '已移除词库'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      新词 {summary.new_count} · 学习中 {summary.learning_count}{' '}
                      · 复习 {summary.review_count} · 掌握{' '}
                      {summary.mastered_count}
                    </p>
                  </div>
                  <Badge
                    variant={summary.due_count ? 'destructive' : 'secondary'}
                  >
                    {summary.due_count ? `${summary.due_count} 到期` : '无到期'}
                  </Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>最近学习</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.recent_activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有学习记录。</p>
            ) : (
              overview.recent_activity.map((activity, index) => (
                <div
                  key={`${activity.item_id}-${activity.occurred_at}-${index}`}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium">{activity.word}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(activity.occurred_at)}
                      {activity.device_id ? ' · Note4' : ' · Web'}
                    </p>
                  </div>
                  <Badge
                    variant={
                      activity.action === 'unknown'
                        ? 'destructive'
                        : 'secondary'
                    }
                  >
                    {actionLabel(activity.action)}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>学习会话</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {overview.recent_sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有学习会话。</p>
          ) : (
            overview.recent_sessions.map(session => (
              <div
                key={session.session_id}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">
                    {session.deck_titles.join('、') || 'Word 学习'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {session.status} · {session.next_sequence}/
                    {session.candidate_count} ·{' '}
                    {formatDate(session.last_activity_at)}
                    {session.device_id ? ' · Note4' : ' · Web'}
                  </p>
                </div>
                {!session.device_id ? (
                  <Link
                    className="text-sm text-primary hover:underline"
                    href={`/words/study/${session.session_id}`}
                  >
                    查看会话
                  </Link>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

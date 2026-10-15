import {
  getTranslations as getFeatureTranslations,
  getLocale as getFeatureLocale,
} from 'next-intl/server';
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
  const tFeature = await getFeatureTranslations('Words');

  return { title: tFeature('vocabularyProgress') };
}

async function ProgressCards({
  overview,
}: {
  overview: WebWordProgressOverview;
}) {
  const tFeature = await getFeatureTranslations('Words');

  const cards = [
    [tFeature('totalEntries'), overview.totals.total],
    [tFeature('dueToday'), overview.totals.due_count],
    [
      tFeature('learning'),
      overview.totals.learning_count + overview.totals.review_count,
    ],
    [tFeature('mastered'), overview.totals.mastered_count],
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
  const tFeature = await getFeatureTranslations('Words');
  const featureLocale = await getFeatureLocale();
  function formatDate(value: string) {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return tFeature('unknownTime');
    return new Intl.DateTimeFormat(featureLocale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }
  function actionLabel(action: string) {
    if (action === 'known') return tFeature('known');
    if (action === 'unknown') return tFeature('unknown');
    if (action === 'skipped') return tFeature('skip');
    if (action === 'looked_up') return tFeature('lookUp');
    return action;
  }

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
        title={tFeature('vocabularyProgress')}
        description={tFeature('webMcpAndWqnNote4ShareYour')}
        actions={
          <Link className="text-sm text-primary hover:underline" href="/words">
            {tFeature('backToDecks')}
          </Link>
        }
      />
      <ProgressCards overview={overview} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{tFeature('progressByDeck')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.decks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {tFeature('noDecksToSummarizeYet')}
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
                      {deckTitleById.get(summary.deck_id) ||
                        tFeature('removedDeck')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {tFeature('newWords')}
                      {summary.new_count} {tFeature('learning2')}
                      {summary.learning_count} {tFeature('review3')}
                      {summary.review_count} {tFeature('mastered2')}{' '}
                      {summary.mastered_count}
                    </p>
                  </div>
                  <Badge
                    variant={summary.due_count ? 'destructive' : 'secondary'}
                  >
                    {summary.due_count
                      ? tFeature('due', {
                          value0: String(summary.due_count ?? ''),
                        })
                      : tFeature('nothingDue')}
                  </Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tFeature('recentStudy')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.recent_activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {tFeature('noStudyHistoryYet')}
              </p>
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
          <CardTitle>{tFeature('studySessions')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {overview.recent_sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {tFeature('noStudySessionsYet')}
            </p>
          ) : (
            overview.recent_sessions.map(session => (
              <div
                key={session.session_id}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">
                    {session.deck_titles.join('、') ||
                      tFeature('vocabularyStudy')}
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
                    {tFeature('viewSession')}
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

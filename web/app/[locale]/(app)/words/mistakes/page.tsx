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
import { loadWrongWords } from '@/lib/words';

export async function generateMetadata(): Promise<Metadata> {
  const tFeature = await getFeatureTranslations('Words');

  return { title: tFeature('vocabularyMistakes') };
}

export default async function WordMistakesPage() {
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

  const { user, supabase } = await requireUser();
  if (!user) redirect('/auth/login?redirect=/words/mistakes');
  const { mistakes } = await loadWrongWords(supabase, user.id, { limit: 50 });

  return (
    <div className="section-container space-y-6">
      <PageHeader
        title={tFeature('vocabularyMistakes')}
        description={tFeature('markingAWordAsUnknownCreatesA')}
        actions={
          <Link className="text-sm text-primary hover:underline" href="/words">
            {tFeature('backToVocabulary')}
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{tFeature('wordsToPractice')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {mistakes.length === 0 ? (
            <div className="rounded-lg border border-dashed px-6 py-12 text-center">
              <p className="font-medium">
                {tFeature('noVocabularyMistakesYet')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {tFeature('wordsMarkedAsUnknownDuringLearningWill')}
              </p>
            </div>
          ) : (
            mistakes.map(item => (
              <div
                key={item.problem_id}
                className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{item.word.word}</p>
                    <Badge variant="destructive">{tFeature('question')}</Badge>
                    <Badge variant="outline">
                      {item.word.status || 'learning'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.word.meaning}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tFeature('lastAddedForReview')}
                    {formatDate(item.updated_at)}
                  </p>
                </div>
                <Link
                  className="text-sm text-primary hover:underline"
                  href={`/problem-sets/${item.problem_set_id}/review?problemId=${item.problem_id}`}
                >
                  {tFeature('reviewQuestion')}
                </Link>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

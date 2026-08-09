'use client';

import { useState } from 'react';
import { AlertCircle, ChevronDown, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { apiUrl } from '@/lib/api-utils';
import {
  ProblemReviewSchedulerDiagnosticsSchema,
  type ProblemReviewSchedulerDiagnostics,
} from '@/lib/fsrs/diagnostics';

function displayNumber(value: number | null) {
  return value === null ? '—' : value.toFixed(2);
}

export default function SchedulerDiagnostics({
  problemId,
}: {
  problemId: string;
}) {
  const t = useTranslations('Review');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [diagnostics, setDiagnostics] =
    useState<ProblemReviewSchedulerDiagnostics | null>(null);

  const load = async () => {
    if (loaded || loading) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(
        apiUrl(`/api/problems/${problemId}/review-scheduler-diagnostics`),
        { cache: 'no-store' }
      );
      if (!response.ok) throw new Error('diagnostics request failed');
      const payload = await response.json();
      setDiagnostics(
        ProblemReviewSchedulerDiagnosticsSchema.parse(payload.data)
      );
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) void load();
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="rounded-xl border border-border bg-card/70">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium">
          <span>{t('schedulerDiagnostics')}</span>
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border px-4 py-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('schedulerLoading')}
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {t('schedulerUnavailable')}
            </div>
          ) : diagnostics ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {diagnostics.authority.algorithm.toUpperCase()}
                </Badge>
                <Badge
                  variant={
                    diagnostics.projection.status === 'ready'
                      ? 'secondary'
                      : 'outline'
                  }
                >
                  {t('schedulerProjectionStatus', {
                    status: diagnostics.projection.status,
                  })}
                </Badge>
                {diagnostics.projection.last_error_code ? (
                  <Badge variant="destructive">
                    {diagnostics.projection.last_error_code}
                  </Badge>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">{t('authorityDue')}</dt>
                  <dd>
                    {diagnostics.authority.next_review_at
                      ? new Date(
                          diagnostics.authority.next_review_at
                        ).toLocaleString()
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('fsrsDue')}</dt>
                  <dd>
                    {diagnostics.fsrs?.next_review_at
                      ? new Date(
                          diagnostics.fsrs.next_review_at
                        ).toLocaleString()
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('fsrsState')}</dt>
                  <dd>{diagnostics.fsrs?.state ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('stability')}</dt>
                  <dd>{displayNumber(diagnostics.fsrs?.stability ?? null)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('difficulty')}</dt>
                  <dd>{displayNumber(diagnostics.fsrs?.difficulty ?? null)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('reviewCounts')}</dt>
                  <dd>
                    {diagnostics.fsrs &&
                    diagnostics.fsrs.reps !== null &&
                    diagnostics.fsrs.lapses !== null
                      ? `${diagnostics.fsrs.reps} / ${diagnostics.fsrs.lapses}`
                      : '—'}
                  </dd>
                </div>
              </dl>

              {diagnostics.fsrs ? (
                <p className="text-xs text-muted-foreground">
                  {diagnostics.fsrs.algorithm_version} ·{' '}
                  {diagnostics.fsrs.library_name}{' '}
                  {diagnostics.fsrs.library_version} ·{' '}
                  {diagnostics.fsrs.parameter_stable_key ?? '—'}
                </p>
              ) : null}

              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('humanRatingTimeline')}
                </p>
                {diagnostics.timeline.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('noRatingHistory')}
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {diagnostics.timeline.map(event => (
                      <li
                        key={event.review_occurrence_id}
                        className="flex items-center justify-between gap-3"
                      >
                        <span>
                          {event.human_rating ?? t('skip')}
                          {event.corrected ? ` · ${t('corrected')}` : ''}
                        </span>
                        <time className="text-muted-foreground">
                          {new Date(event.effective_review_at).toLocaleString()}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

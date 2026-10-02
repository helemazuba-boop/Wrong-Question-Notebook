'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiGet, apiPost } from '@/lib/api-client';

export interface ProblemMarkQueueHealth {
  status_counts: Array<{ status: string; total: number }>;
  error_counts: Array<{ last_error_code: string; total: number }>;
  oldest_pending_age_seconds: number;
  stuck_total: number;
  recent_failures: Array<{
    problem_id: string;
    status: string;
    last_error_code: string | null;
    attempt_count: number;
    updated_at: string;
  }>;
  enqueue_errors: Array<{
    problem_id: string;
    error_text: string;
    occurred_at: string;
  }>;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function ProblemMarksQueueClient({
  initialHealth,
}: {
  initialHealth: ProblemMarkQueueHealth | null;
}) {
  const t = useTranslations('Admin');
  const [health, setHealth] = useState(initialHealth);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function requeue(body: unknown) {
    try {
      await apiPost('/api/admin/problem-marks', body);
      setMessage(t('requeueDone'));
    } catch {
      setMessage(t('requeueFailed'));
    }
  }

  function refresh() {
    startTransition(async () => {
      try {
        const payload = await apiGet<{ health: ProblemMarkQueueHealth }>(
          '/api/admin/problem-marks'
        );
        setHealth(payload.health ?? null);
      } catch {
        setMessage(t('requeueFailed'));
      }
    });
  }

  if (!health) {
    return <p className="text-sm text-gray-500">{t('noFailures')}</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t('problemMarkQueue')}
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('problemMarkQueueDesc')}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          disabled={pending}
          onClick={refresh}
          variant="outline"
          size="sm"
        >
          {t('refresh')}
        </Button>
        <Button
          disabled={pending}
          variant="outline"
          size="sm"
          onClick={() => {
            if (!window.confirm(t('requeueAllConfirm'))) return;
            startTransition(async () => {
              await requeue({ action: 'all' });
              refresh();
            });
          }}
        >
          {t('requeueAll')}
        </Button>
      </div>

      {message ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">{message}</p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t('statusBreakdown')}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
            {health.status_counts.length === 0 ? (
              <li>{t('noFailures')}</li>
            ) : (
              health.status_counts.map(entry => (
                <li key={entry.status}>
                  {entry.status}: {entry.total}
                </li>
              ))
            )}
          </ul>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t('errorBreakdown')}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
            {health.error_counts.length === 0 ? (
              <li>{t('noFailures')}</li>
            ) : (
              health.error_counts.map(entry => (
                <li key={entry.last_error_code}>
                  {entry.last_error_code}: {entry.total}
                </li>
              ))
            )}
          </ul>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t('oldestPending')}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {formatAge(health.oldest_pending_age_seconds)}
          </p>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t('stuckTotal')}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {health.stuck_total}
          </p>
        </Card>
      </div>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          {t('recentFailures')}
        </h2>
        {health.recent_failures.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">{t('noFailures')}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {health.recent_failures.map(entry => (
              <li
                key={entry.problem_id}
                className="flex flex-wrap items-center gap-2 text-gray-600 dark:text-gray-400"
              >
                <span className="font-mono text-xs">{entry.problem_id}</span>
                <span>{entry.status}</span>
                <span>{entry.last_error_code ?? t('unknownError')}</span>
                <span>
                  {t('attemptCount')}: {entry.attempt_count}
                </span>
                <Button
                  disabled={pending}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    startTransition(async () => {
                      await requeue({
                        action: 'problem',
                        problem_id: entry.problem_id,
                      });
                      refresh();
                    })
                  }
                >
                  {t('requeue')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          {t('enqueueFailures')}
        </h2>
        {health.enqueue_errors.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">{t('noFailures')}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm text-gray-600 dark:text-gray-400">
            {health.enqueue_errors.map((entry, index) => (
              <li key={`${entry.problem_id}-${index}`}>
                <span className="font-mono text-xs">{entry.problem_id}</span>{' '}
                {entry.error_text}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

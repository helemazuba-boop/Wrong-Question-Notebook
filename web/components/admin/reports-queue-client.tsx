'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { ModerationReport } from '@/lib/moderation';
import { RichTextDisplay } from '@/components/ui/rich-text-display';
import Image from 'next/image';

export function ReportsQueueClient({
  initialReports,
}: {
  initialReports: ModerationReport[];
}) {
  const t = useTranslations('Reports');
  const [reports, setReports] = useState(initialReports);
  const [status, setStatus] = useState('pending');
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<{
    report: string;
    offset: number;
    hasMore: boolean;
    problems: Array<{
      id: string;
      title: string;
      content: string | null;
      assets: string[];
      parts: Array<{
        index: number;
        content?: string;
        options?: Array<{ label: string; text: string }>;
      }>;
    }>;
  } | null>(null);
  async function loadContext(report: string, nextOffset = 0) {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/reports/${report}?offset=${nextOffset}`
      );
      if (!response.ok) throw new Error();
      setPreview({ ...(await response.json()), report, offset: nextOffset });
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function load(nextStatus = status, nextOffset = offset) {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/reports?status=${nextStatus}&offset=${nextOffset}`
      );
      if (!response.ok) throw new Error();
      setReports((await response.json()).reports);
      setStatus(nextStatus);
      setOffset(nextOffset);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(
    report: ModerationReport,
    action: 'dismiss' | 'hide' | 'restore'
  ) {
    if (!message.trim()) {
      toast.error(t('messageRequired'));
      return;
    }
    if (
      !window.confirm(
        t(
          action === 'hide'
            ? 'confirmHide'
            : action === 'restore'
              ? 'confirmRestore'
              : 'confirmDismiss'
        )
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/reports/${report.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, message }),
      });
      if (!response.ok) throw new Error();
      setMessage('');
      toast.success(t('saved'));
      await load();
    } catch {
      toast.error(t('resolutionFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <h1 className="page-title">{t('adminTitle')}</h1>
      <div className="flex gap-2 flex-wrap">
        {(['pending', 'reviewed', 'dismissed', 'all'] as const).map(value => (
          <Button
            key={value}
            disabled={busy}
            variant={status === value ? 'default' : 'outline'}
            onClick={() => load(value, 0)}
          >
            {t(value)}
          </Button>
        ))}
      </div>
      <label className="block space-y-2">
        <span>{t('resultMessage')}</span>
        <Textarea
          value={message}
          maxLength={1000}
          onChange={event => setMessage(event.target.value)}
        />
      </label>
      {error && (
        <div role="alert">
          {t('loadFailed')} <Button onClick={() => load()}>{t('retry')}</Button>
        </div>
      )}
      {!error && reports.length === 0 && <p>{t('emptyQueue')}</p>}
      {reports.map(report => (
        <article className="rounded-xl border p-4 space-y-2" key={report.id}>
          <h2 className="font-semibold">
            {report.target_title ?? t('unavailableContent')}
          </h2>
          <p>{report.reason}</p>
          <p>{report.details}</p>
          <p>{report.result_message}</p>
          {report.problem_set_id && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => loadContext(report.id)}
            >
              {t('viewContent')}
            </Button>
          )}
          {preview?.report === report.id && (
            <div className="space-y-3">
              {preview.problems.map(problem => (
                <section key={problem.id} className="rounded-lg border p-3">
                  <h3>{problem.title}</h3>
                  <RichTextDisplay content={problem.content ?? ''} />
                  {problem.parts.map(part => (
                    <div key={part.index}>
                      <RichTextDisplay content={part.content ?? ''} />
                      {part.options?.map(option => (
                        <p key={option.label}>
                          {option.label}: {option.text}
                        </p>
                      ))}
                    </div>
                  ))}
                  {problem.assets.map(url => (
                    <Image
                      unoptimized
                      width={1000}
                      height={1000}
                      key={url}
                      src={url}
                      alt={problem.title}
                      className="max-w-full h-auto"
                    />
                  ))}
                </section>
              ))}
              {preview.offset > 0 && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    loadContext(report.id, Math.max(0, preview.offset - 50))
                  }
                >
                  {t('previous')}
                </Button>
              )}
              {preview.hasMore && (
                <Button
                  disabled={busy}
                  onClick={() => loadContext(report.id, preview.offset + 50)}
                >
                  {t('next')}
                </Button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            {report.status === 'pending' && (
              <>
                <Button
                  disabled={busy}
                  onClick={() => resolve(report, 'dismiss')}
                >
                  {t('dismiss')}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy || !report.problem_set_id}
                  onClick={() => resolve(report, 'hide')}
                >
                  {t('hide')}
                </Button>
              </>
            )}
            {report.resolution_action === 'hide' && (
              <Button
                disabled={busy}
                onClick={() => resolve(report, 'restore')}
              >
                {t('restore')}
              </Button>
            )}
          </div>
        </article>
      ))}
      <div className="flex gap-2">
        {offset > 0 && (
          <Button
            disabled={busy}
            onClick={() => load(status, Math.max(0, offset - 50))}
          >
            {t('previous')}
          </Button>
        )}
        {reports.length === 50 && (
          <Button disabled={busy} onClick={() => load(status, offset + 50)}>
            {t('next')}
          </Button>
        )}
      </div>
    </div>
  );
}

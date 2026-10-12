'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { apiGet, apiPost, isApiError } from '@/lib/api-client';
type Job = {
  id: string;
  kind: 'export' | 'delete';
  status: string;
  expires_at: string | null;
  last_error: string | null;
};
export function AccountDataClient({
  email,
  active,
}: {
  email: string;
  active: boolean;
}) {
  const t = useTranslations('AccountData');
  const [now, setNow] = useState(Date.now);
  const [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(''),
    [offset, setOffset] = useState(0),
    [deleting, setDeleting] = useState(!active);
  async function load(nextOffset = offset) {
    try {
      const result = await apiGet<{ jobs: Job[] }>(
        `/api/account/data?offset=${nextOffset}`,
        { cache: 'no-store' }
      );
      setJobs(result.jobs);
      setNow(Date.now());
      setOffset(nextOffset);
      setError(false);
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    void load(0);
    const timer = setInterval(() => void load(0), 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function reauthenticate() {
    setBusy(true);
    try {
      const { error } = await createClient().auth.signInWithPassword({
        email,
        password,
      });
      setPassword('');
      if (error) throw new Error();
      toast.success(t('authenticated'));
    } catch {
      toast.error(t('authFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function start(kind: 'export' | 'delete') {
    if (
      !window.confirm(t(kind === 'delete' ? 'confirmDelete' : 'confirmExport'))
    )
      return;
    setBusy(true);
    try {
      await apiPost('/api/account/data', { kind, confirm: true });
      if (kind === 'delete') setDeleting(true);
      await load(0);
    } catch (error) {
      toast.error(
        t(
          isApiError(error) && error.message === 'reauthentication_required'
            ? 'reauthRequired'
            : isApiError(error) &&
                error.message === 'account_operation_forbidden'
              ? 'forbidden'
              : 'operationFailed'
        )
      );
    } finally {
      setBusy(false);
    }
  }
  async function download(id: string) {
    try {
      const { url } = await apiGet<{ url: string }>(
        `/api/account/data/${id}/download`
      );
      window.location.assign(url);
    } catch {
      toast.error(t('downloadFailed'));
    }
  }
  return (
    <div className="section-container space-y-5">
      <h1 className="page-title">{t('title')}</h1>
      <p>{t('description')}</p>
      {!deleting && (
        <section className="space-y-3 rounded-xl border p-4">
          <h2>{t('reauthTitle')}</h2>
          <p>{t('reauthDescription')}</p>
          <label className="block">
            {t('password')}
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </label>
          <Button disabled={busy || !password} onClick={reauthenticate}>
            {t('authenticate')}
          </Button>
          <p>
            <Link href="/auth/login?redirect=/account&reauth=1">
              {t('loginAgain')}
            </Link>
          </p>
        </section>
      )}
      <section className="space-y-3 rounded-xl border p-4">
        <h2>{t('exportTitle')}</h2>
        <p>{t('exportDescription')}</p>
        <Button disabled={busy || deleting} onClick={() => start('export')}>
          {t('requestExport')}
        </Button>
      </section>
      <section className="space-y-3 rounded-xl border p-4">
        <h2>{t('deleteTitle')}</h2>
        <p>{t('deleteDescription')}</p>
        <Button
          variant="destructive"
          disabled={busy || deleting}
          onClick={() => start('delete')}
        >
          {t('requestDelete')}
        </Button>
      </section>
      {deleting && <p role="status">{t('deletionPending')}</p>}
      {error && (
        <p role="alert">
          {t('statusUnavailable')}{' '}
          <Button onClick={() => load()}>{t('retry')}</Button>
        </p>
      )}
      {jobs.map(job => (
        <article key={job.id} className="rounded-xl border p-4 space-y-2">
          <h2>{t(job.kind === 'export' ? 'exportTitle' : 'deleteTitle')}</h2>
          <p>
            {t(
              job.status === 'completed'
                ? 'completed'
                : job.status === 'failed'
                  ? 'failed'
                  : job.status === 'cancelled'
                    ? 'cancelled'
                    : job.status === 'running'
                      ? 'running'
                      : job.last_error
                        ? 'retrying'
                        : 'pending'
            )}
          </p>
          {job.status === 'completed' && job.kind === 'delete' && (
            <p>{t('deleted')}</p>
          )}
          {job.status === 'completed' &&
            job.kind === 'export' &&
            (Date.parse(job.expires_at ?? '') > now ? (
              <Button disabled={deleting} onClick={() => download(job.id)}>
                {t('download')}
              </Button>
            ) : (
              <p>{t('expired')}</p>
            ))}
        </article>
      ))}
      <nav className="flex gap-3">
        {offset > 0 && (
          <Button onClick={() => load(Math.max(0, offset - 50))}>
            {t('previous')}
          </Button>
        )}
        {jobs.length === 50 && (
          <Button onClick={() => load(offset + 50)}>{t('next')}</Button>
        )}
      </nav>
    </div>
  );
}

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { PageHeader } from '@/components/page-header';
import { Link } from '@/i18n/navigation';

export default async function ReportHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { user, supabase } = await requireUser();
  if (!user) redirect('/auth/login');
  const requested = Number((await searchParams).page ?? 1);
  const page =
    Number.isSafeInteger(requested) && requested > 0 && requested < 100000
      ? requested
      : 1;
  const { data, error, count } = await (supabase as any)
    .from('problem_set_reports')
    .select(
      'id, target_title, status, result_message, reviewed_at, created_at',
      { count: 'exact' }
    )
    .eq('reporter_user_id', user.id)
    .order('created_at', { ascending: false })
    .order('id')
    .range((page - 1) * 50, page * 50 - 1);
  if (error) throw new Error('Report history is unavailable');
  const t = await getTranslations('Reports');
  return (
    <div className="section-container space-y-5">
      <PageHeader
        title={t('historyTitle')}
        description={t('historyDescription')}
      />
      {(data ?? []).length === 0 && <p>{t('emptyHistory')}</p>}
      {(data ?? []).map(
        (report: {
          id: string;
          target_title: string;
          status: string;
          result_message: string | null;
        }) => (
          <article key={report.id} className="rounded-xl border p-4 space-y-2">
            <h2 className="font-semibold">
              {report.target_title ?? t('unavailableContent')}
            </h2>
            <p>
              {t(
                report.status === 'pending'
                  ? 'pending'
                  : report.status === 'dismissed'
                    ? 'dismissed'
                    : 'reviewed'
              )}
            </p>
            <p>{report.result_message ?? t('awaitingReview')}</p>
          </article>
        )
      )}
      <nav className="flex gap-4">
        {page > 1 && (
          <Link href={`/reports?page=${page - 1}`}>{t('previous')}</Link>
        )}
        {(count ?? 0) > page * 50 && (
          <Link href={`/reports?page=${page + 1}`}>{t('next')}</Link>
        )}
      </nav>
    </div>
  );
}

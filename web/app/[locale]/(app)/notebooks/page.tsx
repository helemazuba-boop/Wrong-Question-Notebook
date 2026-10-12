import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { PageHeader } from '@/components/page-header';
import { appendFromParam } from '@/lib/navigation-context';

export async function generateMetadata() {
  return { title: (await getTranslations('Notebooks'))('title') };
}

export default async function NotebooksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { user, supabase } = await requireUser();
  if (!user) redirect('/auth/login');
  const requested = Number((await searchParams).page ?? 1);
  const page =
    Number.isSafeInteger(requested) && requested >= 1 && requested <= 100000
      ? requested
      : 1;
  const { data, error, count } = await supabase
    .from('notebooks')
    .select('id, title, description, subjects(name)', { count: 'exact' })
    .eq('user_id', user.id)
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .order('id')
    .range((page - 1) * 50, page * 50 - 1);
  if (error) throw new Error('Notebook library is unavailable');
  const t = await getTranslations('Notebooks');
  return (
    <div className="section-container space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <Link href="/subjects" className="underline">
        {t('manageOnShelf')}
      </Link>
      {(data ?? []).length === 0 ? (
        <p>{t('empty')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(data ?? []).map(notebook => (
            <Link
              key={notebook.id}
              aria-label={notebook.title}
              href={appendFromParam(
                `/notebooks/${notebook.id}`,
                `/notebooks?page=${page}`
              )}
              className="rounded-xl border p-5 space-y-2 hover:bg-muted/50"
            >
              <h2 className="font-semibold">{notebook.title}</h2>
              <p className="text-sm text-muted-foreground">
                {notebook.description}
              </p>
              <p className="text-xs text-muted-foreground">
                {notebook.subjects?.name}
              </p>
            </Link>
          ))}
        </div>
      )}
      <nav className="flex gap-4" aria-label={t('pagination')}>
        {page > 1 && (
          <Link href={`/notebooks?page=${page - 1}`}>{t('previous')}</Link>
        )}
        {(count ?? 0) > page * 50 && (
          <Link href={`/notebooks?page=${page + 1}`}>{t('next')}</Link>
        )}
      </nav>
    </div>
  );
}

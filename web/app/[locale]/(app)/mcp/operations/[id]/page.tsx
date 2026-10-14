import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireUser } from '@/lib/supabase/requireUser';
import OperationClient from './operation-client';

export default async function OperationPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id, locale } = await params;
  const { user } = await requireUser();
  if (!user)
    redirect(
      `/${locale}/auth/login?redirect=${encodeURIComponent(`/${locale}/mcp/operations/${id}`)}`
    );
  const t = await getTranslations('McpOperation');
  return (
    <div className="mx-auto max-w-5xl space-y-5 py-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="text-muted-foreground">{t('intro')}</p>
      <OperationClient operationId={id} />
    </div>
  );
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import McpIdeaConfirmClient from './mcp-idea-confirm-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('McpIdeaConfirm');
  return {
    title: t('title'),
    description: t('pageSubtitle'),
  };
}

export default async function McpIdeaConfirmPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('McpIdeaConfirm');

  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="landing-card space-y-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('pageSubtitle')}
          </p>
        </div>
        <McpIdeaConfirmClient challengeId={id} />
      </div>
    </div>
  );
}

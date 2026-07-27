import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import McpPageClient from './mcp-page-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Mcp');
  return {
    title: t('title'),
    description: t('pageSubtitle'),
  };
}

export default function McpPage() {
  return <McpPageClient />;
}

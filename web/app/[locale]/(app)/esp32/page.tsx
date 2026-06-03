import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import Esp32PageClient from './esp32-page-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('ESP32');
  return {
    title: t('title'),
    description: t('pageSubtitle'),
  };
}

export default function Esp32Page() {
  return <Esp32PageClient />;
}

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';

export default async function NotebooksPage() {
  redirect({ href: '/subjects', locale: await getLocale() });
}

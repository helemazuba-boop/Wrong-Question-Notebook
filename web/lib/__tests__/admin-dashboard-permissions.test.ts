import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import zh from '@/messages/zh-CN.json';
const state = vi.hoisted(() => ({ superAdmin: false }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: any) =>
    createElement('a', { ...props, href }, children),
}));
vi.mock('@/lib/user-management', () => ({
  isCurrentUserAdmin: async () => true,
  isCurrentUserSuperAdmin: async () => state.superAdmin,
  getUserStatistics: async () => null,
  getContentStatistics: async () => ({
    total_problems: 0,
    total_subjects: 0,
    total_problem_sets: 0,
    total_attempts: 0,
  }),
  getTotalStorageUsage: async () => ({ totalBytes: 0, fileCount: 0 }),
  getRecentActivity: async () => [],
}));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
import Dashboard from '@/app/[locale]/(app)/admin/page';
import { QuickActions } from '@/components/admin/dashboard/quick-actions';
beforeEach(() => {
  state.superAdmin = false;
});
function render(locale: 'en' | 'zh-CN', isSuperAdmin: boolean) {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, messages: locale === 'en' ? en : zh, timeZone: 'UTC' },
      createElement(QuickActions, { isSuperAdmin })
    )
  );
}
describe('dashboard action permissions', () => {
  it.each(['en', 'zh-CN'] as const)(
    'shows only permitted actions to an admin in %s',
    locale => {
      const html = render(locale, false);
      for (const path of ['/admin/users', '/admin/activity'])
        expect(html).toContain(`href="${path}"`);
      for (const path of [
        '/admin/announcements',
        '/admin/settings',
        '/admin/problem-marks',
      ])
        expect(html).not.toContain(`href="${path}"`);
    }
  );
  it.each(['en', 'zh-CN'] as const)(
    'retains all five actions for a super-admin in %s',
    locale => {
      const html = render(locale, true);
      for (const path of [
        '/admin/users',
        '/admin/activity',
        '/admin/announcements',
        '/admin/settings',
        '/admin/problem-marks',
      ])
        expect(html).toContain(`href="${path}"`);
    }
  );
  it('passes the current viewer permission separately from shared dashboard statistics', async () => {
    expect((await Dashboard()).props.isSuperAdmin).toBe(false);
    state.superAdmin = true;
    expect((await Dashboard()).props.isSuperAdmin).toBe(true);
    state.superAdmin = false;
    expect((await Dashboard()).props.isSuperAdmin).toBe(false);
  });
});

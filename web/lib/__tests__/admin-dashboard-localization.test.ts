import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import zh from '@/messages/zh-CN.json';
import en from '@/messages/en.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: any) =>
    createElement('a', { ...props, href }, children),
  usePathname: () => '/admin',
}));
import { DashboardClient } from '@/components/admin/dashboard/dashboard-client';
import { AdminSidebar } from '@/components/admin/admin-sidebar';

function render(locale: 'en' | 'zh-CN', fileCount: number) {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale,
        messages: locale === 'en' ? en : zh,
        timeZone: 'Asia/Shanghai',
      },
      createElement(
        'div',
        null,
        createElement(AdminSidebar, { role: 'super_admin' }),
        createElement(DashboardClient, {
          userStats: {
            total_users: 12,
            active_users: 10,
            admin_users: 1,
            new_users_today: 0,
            new_users_this_week: 2,
          },
          contentStats: {
            total_problems: 20,
            total_subjects: 4,
            total_problem_sets: 3,
            total_attempts: 50,
          },
          storageStats: { totalBytes: 9646899, fileCount },
          recentActivity: [],
        })
      )
    )
  );
}

describe('admin dashboard localization and storage interpolation', () => {
  it('renders navigation, quick actions and the empty state in Chinese', () => {
    const html = render('zh-CN', 42);
    for (const text of [
      zh.Admin.adminPanel,
      '仪表板',
      '管理用户',
      '查看活动',
      '暂无活动记录',
    ])
      expect(html).toContain(text);
    expect(html).toContain('42 个文件');
    expect(html).not.toMatch(
      /Admin Panel|Dashboard|Manage Users|View Activity|No recent activity/
    );
  });

  it.each([0, 1, 42])(
    'renders the actual Chinese file count %s, including zero',
    count => {
      expect(render('zh-CN', count)).toContain(`${count} 个文件`);
    }
  );

  it('renders English navigation and pluralizes actual file counts', () => {
    expect(render('en', 1)).toContain('1 file');
    const html = render('en', 42);
    expect(html).toContain('42 files');
    expect(html).toContain('Manage Users');
    expect(html).toContain('No activity recorded');
    expect(html).not.toContain('个文件');
  });
});

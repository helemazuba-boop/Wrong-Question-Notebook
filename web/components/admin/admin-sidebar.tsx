'use client';

import { Link } from '@/i18n/navigation';
import { usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  Settings,
  Activity,
  Shield,
  Megaphone,
  ArrowLeft,
} from 'lucide-react';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';

const adminNavItems = [
  {
    title: 'dashboard',
    href: ROUTES.ADMIN.DASHBOARD,
    icon: LayoutDashboard,
  },
  { title: 'Reports', href: '/admin/reports', icon: Shield },
  {
    title: 'users',
    href: ROUTES.ADMIN.USERS,
    icon: Users,
  },
  {
    title: 'activity',
    href: ROUTES.ADMIN.ACTIVITY,
    icon: Activity,
  },
  {
    title: 'announcements',
    href: ROUTES.ADMIN.ANNOUNCEMENTS,
    icon: Megaphone,
  },
  {
    title: 'settings',
    href: ROUTES.ADMIN.SETTINGS,
    icon: Settings,
  },
] as const;

interface AdminSidebarProps {
  onNavigate?: () => void;
  role: string;
  className?: string;
}

export function AdminSidebar({
  onNavigate,
  role,
  className,
}: AdminSidebarProps) {
  const t = useTranslations('Admin');
  const tReports = useTranslations('Reports');
  const pathname = usePathname();
  const roleLabel =
    role === 'super_admin'
      ? t('superAdminRole')
      : role === 'admin'
        ? t('admin')
        : role === 'moderator'
          ? t('moderator')
          : t('regularUserRole');

  const isActive = (href: string) => {
    if (href === ROUTES.ADMIN.DASHBOARD) {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  return (
    <div className={cn('h-full flex flex-col admin-sidebar', className)}>
      {/* Header */}
      <div className="p-6 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 shrink-0 rounded-xl bg-amber-500/10 dark:bg-amber-500/20 flex items-center justify-center">
            <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <span className="font-semibold text-gray-900 dark:text-white text-sm">
              {t('adminPanel')}
            </span>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {roleLabel}
            </p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav aria-label={t('adminNavigation')} className="flex-1 px-3 space-y-1">
        {adminNavItems
          .filter(
            item =>
              role === 'super_admin' ||
              (item.href === '/admin/reports' &&
                ['moderator', 'admin'].includes(role)) ||
              (role === 'admin' &&
                item.href !== ROUTES.ADMIN.SETTINGS &&
                item.href !== ROUTES.ADMIN.ANNOUNCEMENTS)
          )
          .map(item => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                  active
                    ? 'bg-amber-100/80 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-amber-50/60 dark:hover:bg-stone-800/50 hover:text-gray-900 dark:hover:text-gray-200'
                )}
              >
                <item.icon
                  className={cn(
                    'h-4 w-4 shrink-0',
                    active
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-gray-400 dark:text-gray-500'
                  )}
                />
                {item.title === 'Reports'
                  ? tReports('adminTitle')
                  : t(item.title)}
              </Link>
            );
          })}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-amber-200/30 dark:border-stone-800">
        <Link
          href={ROUTES.SUBJECTS}
          onClick={onNavigate}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-amber-50/60 dark:hover:bg-stone-800/50 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          {t('backToApp')}
        </Link>
      </div>
    </div>
  );
}

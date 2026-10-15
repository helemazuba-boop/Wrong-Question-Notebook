import { Link } from '@/i18n/navigation';
import {
  Users,
  Settings,
  Activity,
  Megaphone,
  Tags,
  ArrowRight,
} from 'lucide-react';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';

const actions = [
  {
    title: 'manageUsersAction',
    description: 'manageUsersActionDesc',
    href: ROUTES.ADMIN.USERS,
    superAdminOnly: false,
    icon: Users,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-500/10 dark:bg-blue-500/20',
  },
  {
    title: 'viewActivityAction',
    description: 'viewActivityActionDesc',
    href: ROUTES.ADMIN.ACTIVITY,
    superAdminOnly: false,
    icon: Activity,
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500/10 dark:bg-emerald-500/20',
  },
  {
    title: 'announcements',
    description: 'announcementsActionDesc',
    href: ROUTES.ADMIN.ANNOUNCEMENTS,
    superAdminOnly: true,
    icon: Megaphone,
    color: 'text-orange-600 dark:text-orange-400',
    bg: 'bg-orange-500/10 dark:bg-orange-500/20',
  },
  {
    title: 'settings',
    description: 'settingsActionDesc',
    href: ROUTES.ADMIN.SETTINGS,
    superAdminOnly: true,
    icon: Settings,
    color: 'text-purple-600 dark:text-purple-400',
    bg: 'bg-purple-500/10 dark:bg-purple-500/20',
  },
  {
    title: 'problemMarkQueue',
    description: 'problemMarksActionDesc',
    href: ROUTES.ADMIN.PROBLEM_MARKS,
    superAdminOnly: true,
    icon: Tags,
    color: 'text-rose-600 dark:text-rose-400',
    bg: 'bg-rose-500/10 dark:bg-rose-500/20',
  },
] as const;

export function QuickActions({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const t = useTranslations('Admin');
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15.5rem),1fr))] gap-3">
      {actions
        .filter(action => isSuperAdmin || !action.superAdminOnly)
        .map(action => (
          <Link
            key={action.href}
            href={action.href}
            className="flex min-w-0 items-center gap-3 p-3 rounded-xl border border-amber-200/30 dark:border-stone-800/50 hover:bg-amber-50/50 dark:hover:bg-stone-800/30 transition-colors group"
          >
            <div
              className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${action.bg}`}
            >
              <action.icon className={`w-4 h-4 ${action.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm leading-5 break-words font-medium text-gray-900 dark:text-white">
                {t(action.title)}
              </p>
              <p className="text-xs leading-5 break-words text-gray-500 dark:text-gray-400">
                {t(action.description)}
              </p>
            </div>
            <ArrowRight className="w-4 h-4 shrink-0 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors" />
          </Link>
        ))}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { usePathname } from '@/i18n/navigation';
import {
  Menu,
  BookOpen,
  Globe,
  BarChart3,
  Cpu,
  ListTodo,
  Plug,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type NavLabelKey =
  'subjects' | 'todos' | 'statistics' | 'discover' | 'esp32' | 'mcp';

type AppLink = {
  href: string;
  labelKey: NavLabelKey;
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  activeHrefs?: string[];
};

const APP_LINKS: AppLink[] = [
  {
    href: '/subjects',
    labelKey: 'subjects' as const,
    icon: BookOpen,
    iconBg: 'bg-amber-500/10 dark:bg-amber-500/20',
    iconColor: 'text-amber-600 dark:text-amber-400',
    activeHrefs: ['/problem-sets', '/notebooks'],
  },
  {
    href: '/todos',
    labelKey: 'todos' as const,
    icon: ListTodo,
    iconBg: 'bg-emerald-500/10 dark:bg-emerald-500/20',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    href: '/statistics',
    labelKey: 'statistics' as const,
    icon: BarChart3,
    iconBg: 'bg-green-500/10 dark:bg-green-500/20',
    iconColor: 'text-green-600 dark:text-green-400',
    activeHrefs: ['/insights'],
  },
  {
    href: '/discover',
    labelKey: 'discover' as const,
    icon: Globe,
    iconBg: 'bg-purple-500/10 dark:bg-purple-500/20',
    iconColor: 'text-purple-600 dark:text-purple-400',
  },
  {
    href: '/esp32',
    labelKey: 'esp32' as const,
    icon: Cpu,
    iconBg: 'bg-rose-500/10 dark:bg-rose-500/20',
    iconColor: 'text-rose-600 dark:text-rose-400',
  },
  {
    href: '/mcp',
    labelKey: 'mcp' as const,
    icon: Plug,
    iconBg: 'bg-blue-500/10 dark:bg-blue-500/20',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
];

function isActivePath(
  pathname: string | null,
  href: string,
  activeHrefs: string[] = []
) {
  if (!pathname) return false;
  return [href, ...activeHrefs].some(
    path => pathname === path || pathname.startsWith(`${path}/`)
  );
}

function NavLink({
  href,
  labelKey,
}: {
  href: string;
  labelKey: (typeof APP_LINKS)[number]['labelKey'];
}) {
  const t = useTranslations('Navigation');
  const pathname = usePathname();
  const active = isActivePath(
    pathname,
    href,
    APP_LINKS.find(link => link.href === href)?.activeHrefs
  );

  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(
        'text-base text-muted-foreground hover:text-foreground transition-all duration-200 border-b-2 border-transparent pb-0.5 hover:border-amber-300/50 dark:hover:border-amber-700/50',
        active &&
          'text-foreground font-medium border-amber-500 dark:border-amber-400 hover:border-amber-500 dark:hover:border-amber-400'
      )}
      aria-current={active ? 'page' : undefined}
    >
      {t(labelKey)}
    </Link>
  );
}

function MobileNavLink({
  href,
  labelKey,
  icon: Icon,
  iconBg,
  iconColor,
  onClick,
}: {
  href: string;
  labelKey: (typeof APP_LINKS)[number]['labelKey'];
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  onClick?: () => void;
}) {
  const t = useTranslations('Navigation');
  const pathname = usePathname();
  const active = isActivePath(
    pathname,
    href,
    APP_LINKS.find(link => link.href === href)?.activeHrefs
  );

  return (
    <Link
      href={href}
      prefetch={false}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 text-gray-600 dark:text-gray-400',
        active && 'font-semibold text-gray-900 dark:text-white'
      )}
      aria-current={active ? 'page' : undefined}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          iconBg
        )}
      >
        <Icon className={cn('h-[18px] w-[18px]', iconColor)} />
      </span>
      <span className="text-[15px]">{t(labelKey)}</span>
    </Link>
  );
}

export function AppNavLinks() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="hidden items-center gap-6 md:flex">
        {APP_LINKS.map(l => (
          <NavLink key={l.href} href={l.href} labelKey={l.labelKey} />
        ))}
      </div>

      <div className="md:hidden">
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 rounded-xl"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-full space-y-2 rounded-xl border-amber-200/40 p-2 dark:border-amber-800/30"
          >
            {APP_LINKS.map(l => (
              <DropdownMenuItem
                key={l.href}
                asChild
                className="rounded-lg px-2.5 py-2.5 focus:bg-amber-50/80 dark:focus:bg-amber-900/20"
              >
                <MobileNavLink
                  href={l.href}
                  labelKey={l.labelKey}
                  icon={l.icon}
                  iconBg={l.iconBg}
                  iconColor={l.iconColor}
                  onClick={() => setOpen(false)}
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

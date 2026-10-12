import { type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFormatter } from 'next-intl';

const colorVariants = {
  amber: {
    card: 'from-amber-50 to-amber-100/50 dark:from-amber-950/40 dark:to-amber-900/20 border-amber-200/40 dark:border-amber-800/30',
    icon: 'bg-amber-500/10 dark:bg-amber-500/20',
    iconColor: 'text-amber-600 dark:text-amber-400',
    value: 'text-amber-700 dark:text-amber-300',
  },
  emerald: {
    card: 'from-emerald-50 to-emerald-100/50 dark:from-emerald-950/40 dark:to-emerald-900/20 border-emerald-200/40 dark:border-emerald-800/30',
    icon: 'bg-emerald-500/10 dark:bg-emerald-500/20',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    value: 'text-emerald-700 dark:text-emerald-300',
  },
  blue: {
    card: 'from-blue-50 to-blue-100/50 dark:from-blue-950/40 dark:to-blue-900/20 border-blue-200/40 dark:border-blue-800/30',
    icon: 'bg-blue-500/10 dark:bg-blue-500/20',
    iconColor: 'text-blue-600 dark:text-blue-400',
    value: 'text-blue-700 dark:text-blue-300',
  },
  purple: {
    card: 'from-purple-50 to-purple-100/50 dark:from-purple-950/40 dark:to-purple-900/20 border-purple-200/40 dark:border-purple-800/30',
    icon: 'bg-purple-500/10 dark:bg-purple-500/20',
    iconColor: 'text-purple-600 dark:text-purple-400',
    value: 'text-purple-700 dark:text-purple-300',
  },
  orange: {
    card: 'from-orange-50 to-orange-100/50 dark:from-orange-950/40 dark:to-orange-900/20 border-orange-200/40 dark:border-orange-800/30',
    icon: 'bg-orange-500/10 dark:bg-orange-500/20',
    iconColor: 'text-orange-600 dark:text-orange-400',
    value: 'text-orange-700 dark:text-orange-300',
  },
  rose: {
    card: 'from-rose-50 to-rose-100/50 dark:from-rose-950/40 dark:to-rose-900/20 border-rose-200/40 dark:border-rose-800/30',
    icon: 'bg-rose-500/10 dark:bg-rose-500/20',
    iconColor: 'text-rose-600 dark:text-rose-400',
    value: 'text-rose-700 dark:text-rose-300',
  },
} as const;

type StatColor = keyof typeof colorVariants;

interface StatCardProps {
  icon: LucideIcon;
  value: number | string;
  label: string;
  sublabel?: string;
  color: StatColor;
}

export function StatCard({
  icon: Icon,
  value,
  label,
  sublabel,
  color,
}: StatCardProps) {
  const v = colorVariants[color];
  const format = useFormatter();

  return (
    <div className={cn('admin-stat-card min-w-0', v.card)}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm leading-5 font-medium text-gray-600 dark:text-gray-400">
          {label}
        </p>
        <div
          className={cn(
            'w-9 h-9 shrink-0 rounded-xl flex items-center justify-center',
            v.icon
          )}
        >
          <Icon className={cn('w-5 h-5', v.iconColor)} />
        </div>
      </div>
      <p
        className={cn(
          'mt-2 whitespace-nowrap text-2xl font-bold tabular-nums',
          v.value
        )}
      >
        {typeof value === 'number' ? format.number(value) : value}
      </p>
      {sublabel && (
        <p className="mt-1 text-xs leading-5 break-words text-gray-500 dark:text-gray-400">
          {sublabel}
        </p>
      )}
    </div>
  );
}

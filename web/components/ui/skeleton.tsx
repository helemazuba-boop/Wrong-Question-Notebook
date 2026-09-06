'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Standard shadcn/ui skeleton. The only sanctioned loading placeholder for
 * content areas; spinners are reserved for in-button/in-row pending states.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };

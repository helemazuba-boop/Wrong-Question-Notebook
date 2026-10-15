'use client';

import { usePathname } from '@/i18n/navigation';

export function AppMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');

  return (
    <main
      id="main-content"
      className={isAdmin ? 'w-full min-w-0' : 'page-container main-content'}
    >
      {children}
    </main>
  );
}

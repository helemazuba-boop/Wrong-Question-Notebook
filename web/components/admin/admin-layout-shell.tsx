'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from '@/components/ui/sheet';
import { AdminSidebar } from './admin-sidebar';

export function AdminLayoutShell({
  children,
  role,
}: {
  children: React.ReactNode;
  role: string;
}) {
  const t = useTranslations('Admin');
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <div className="admin-page-bg grid min-h-[calc(100dvh-4.0625rem)] grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden min-w-0 lg:block">
          <div className="sticky top-[4.0625rem]">
            <AdminSidebar
              role={role}
              className="min-h-[calc(100dvh-4.0625rem)]"
            />
          </div>
        </aside>

        <div className="min-w-0 px-4 py-6 sm:px-6 xl:px-8">
          <SheetTrigger asChild>
            <Button variant="outline" className="mb-5 gap-2 lg:hidden">
              <Menu className="h-4 w-4 shrink-0" />
              {t('adminNavigation')}
            </Button>
          </SheetTrigger>
          {children}
        </div>
      </div>
      <SheetContent side="left" className="w-60 overflow-y-auto p-0">
        <SheetTitle className="sr-only">{t('adminNavigation')}</SheetTitle>
        <AdminSidebar role={role} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

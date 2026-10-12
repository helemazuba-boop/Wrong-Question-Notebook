'use client';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { OnboardingStatus } from '@/lib/types';
export function WelcomeModal({
  open,
  onClose,
  onChoose,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (scenario: NonNullable<OnboardingStatus['scenario']>) => void;
  busy: boolean;
}) {
  const t = useTranslations('Onboarding');
  return (
    <Dialog open={open} onOpenChange={value => !value && onClose()}>
      <DialogContent>
        <DialogTitle>{t('chooseScenario')}</DialogTitle>
        <DialogDescription>{t('scenarioDescription')}</DialogDescription>
        <div className="grid gap-3">
          {(['problems', 'notes', 'words'] as const).map(scenario => (
            <Button
              key={scenario}
              variant="outline"
              disabled={busy}
              onClick={() => onChoose(scenario)}
            >
              {t(scenario)}
            </Button>
          ))}
        </div>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('dismissOnboarding')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

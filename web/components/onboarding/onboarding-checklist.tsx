'use client';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { OnboardingStatus } from '@/lib/types';
import { CheckCircle2, Circle } from 'lucide-react';
const labels = {
  problems: ['problemsContainer', 'problemsContent', 'problemsPractice'],
  notes: ['notesContainer', 'notesContent', 'notesPractice'],
  words: ['wordsContainer', 'wordsContent', 'wordsPractice'],
} as const;
export function OnboardingChecklist({
  status,
  isExpanded,
  onToggleExpanded,
  onDismiss,
  onChangeScenario,
  showCongrats,
}: {
  status: OnboardingStatus;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onDismiss: () => void;
  onChangeScenario: () => void;
  showCongrats: boolean;
}) {
  const t = useTranslations('Onboarding'),
    router = useRouter();
  if (!status.scenario) return null;
  const steps = [
    { done: status.hasContainer, href: status.containerHref },
    { done: status.hasContent, href: status.contentHref },
    { done: status.hasPracticed, href: status.practiceHref },
  ];
  return (
    <aside
      className="fixed bottom-6 right-6 z-50 w-80 rounded-xl border bg-background p-4 shadow-lg space-y-3"
      aria-label={t('gettingStarted')}
    >
      <Button variant="ghost" onClick={onToggleExpanded}>
        {t('gettingStarted')} ({steps.filter(step => step.done).length}/3)
      </Button>
      {isExpanded && (
        <>
          <h3>{t(status.scenario)}</h3>
          {showCongrats ? (
            <p>{t('allDone')}</p>
          ) : (
            steps.map((step, index) => (
              <Button
                key={index}
                variant="ghost"
                className="w-full justify-start"
                onClick={() => router.push(step.href)}
              >
                {step.done ? (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                ) : (
                  <Circle className="mr-2 h-4 w-4" />
                )}
                {t(labels[status.scenario!][index])}
              </Button>
            ))
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onChangeScenario}>
              {t('changeScenario')}
            </Button>
            <Button variant="ghost" onClick={onDismiss}>
              {t('dismissOnboarding')}
            </Button>
          </div>
        </>
      )}
    </aside>
  );
}

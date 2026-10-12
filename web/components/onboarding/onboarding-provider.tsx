'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePathname } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import type { OnboardingStatus } from '@/lib/types';
import { WelcomeModal } from './welcome-modal';
import { OnboardingChecklist } from './onboarding-checklist';
import { toast } from 'sonner';
import { apiGet, apiPost } from '@/lib/api-client';
const OnboardingContext = createContext({ refreshChecklistStatus: () => {} });
export function useOnboarding() {
  return useContext(OnboardingContext);
}
export function OnboardingProvider({
  showOnboarding,
  children,
}: {
  showOnboarding: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations('Onboarding'),
    pathname = usePathname();
  const [status, setStatus] = useState<OnboardingStatus | null>(null),
    [dismissed, setDismissed] = useState(false),
    [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState(true),
    [congrats, setCongrats] = useState(false),
    [error, setError] = useState(false);
  const completing = useRef(false);
  const fetchStatus = useCallback(async () => {
    try {
      const result = await apiGet<{ data: OnboardingStatus }>(
        '/api/onboarding/status',
        { cache: 'no-store' }
      );
      setStatus(result.data);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    if (showOnboarding && !dismissed) {
      void fetchStatus();
      const timer = setInterval(() => void fetchStatus(), 30000);
      return () => clearInterval(timer);
    }
  }, [showOnboarding, dismissed, pathname, fetchStatus]);
  async function choose(scenario: NonNullable<OnboardingStatus['scenario']>) {
    setBusy(true);
    try {
      const result = await apiPost<{ data: OnboardingStatus }>(
        '/api/onboarding/status',
        { scenario }
      );
      setStatus(result.data);
      setPicker(false);
    } catch {
      toast.error(t('statusUnavailable'));
    } finally {
      setBusy(false);
    }
  }
  async function dismiss() {
    try {
      await apiPost('/api/onboarding/complete', { dismiss: true });
      setDismissed(true);
    } catch {
      toast.error(t('statusUnavailable'));
    }
  }
  useEffect(() => {
    if (
      !showOnboarding ||
      dismissed ||
      !status?.scenario ||
      !status.hasContainer ||
      !status.hasContent ||
      !status.hasPracticed ||
      completing.current
    )
      return;
    completing.current = true;
    void apiPost('/api/onboarding/complete', {})
      .then(() => {
        setCongrats(true);
      })
      .catch(() => {
        completing.current = false;
        setError(true);
      });
  }, [showOnboarding, dismissed, status]);
  const active = showOnboarding && !dismissed;
  return (
    <OnboardingContext.Provider value={{ refreshChecklistStatus: fetchStatus }}>
      {children}
      {active && error && (
        <div
          className="fixed bottom-6 right-6 z-50 rounded-xl border bg-background p-4"
          role="alert"
        >
          {t('statusUnavailable')}
          <button onClick={fetchStatus}>{t('retry')}</button>
        </div>
      )}
      {active && !error && status && (
        <>
          <WelcomeModal
            open={picker || !status.scenario}
            busy={busy}
            onChoose={choose}
            onClose={dismiss}
          />
          {status.scenario && !picker && (
            <OnboardingChecklist
              status={status}
              isExpanded={expanded}
              onToggleExpanded={() => setExpanded(value => !value)}
              onDismiss={dismiss}
              onChangeScenario={() => setPicker(true)}
              showCongrats={congrats}
            />
          )}
        </>
      )}
    </OnboardingContext.Provider>
  );
}

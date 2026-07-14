'use client';

import { useConsent } from './consent-provider';

export function ConditionalAnalytics() {
  const { consent } = useConsent();

  if (!consent?.analytics) return null;

  // TODO: Replace with your preferred analytics provider (e.g., Baidu Analytics, Umeng)
  return null;
}

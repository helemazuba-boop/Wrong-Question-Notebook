export type Esp32AiAsrProvider = 'dashscope' | 'stepfun';

export interface Esp32AiAsrSelection {
  primary: Esp32AiAsrProvider;
  fallback: Esp32AiAsrProvider | null;
}

export function getEsp32AiAsrSelection(): Esp32AiAsrSelection | null {
  const primaryRaw = (process.env.WQN_ESP32_AI_ASR_PROVIDER || 'dashscope')
    .trim()
    .toLowerCase();
  if (primaryRaw !== 'dashscope' && primaryRaw !== 'stepfun') return null;

  const fallbackRaw = (process.env.WQN_ESP32_AI_ASR_FALLBACK_PROVIDER || 'none')
    .trim()
    .toLowerCase();
  if (fallbackRaw === '' || fallbackRaw === 'none') {
    return { primary: primaryRaw, fallback: null };
  }
  if (fallbackRaw !== 'dashscope' && fallbackRaw !== 'stepfun') return null;
  if (fallbackRaw === primaryRaw) return null;

  return { primary: primaryRaw, fallback: fallbackRaw };
}

export function isAsrFallbackEligibleCode(code: string): boolean {
  return (
    code === 'asr_failed' ||
    code === 'asr_timeout' ||
    code === 'provider_unavailable' ||
    code === 'rate_limited'
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiGet, apiPost } from '@/lib/api-client';

interface MarkEdge {
  part_index: number | null;
  mark: { stable_key: string; name: string; kind: 'knowledge' | 'skill' };
  evidence?: {
    problem_quote: string;
    document_quote: string;
    rationale: string;
  };
}

interface Semantics {
  annotation_status: 'pending' | 'resolved' | 'unresolved' | 'failed';
  targets: MarkEdge[];
  required: { knowledge: MarkEdge[]; skills: MarkEdge[] };
  methods?: { recommended: MarkEdge[]; alternative: MarkEdge[] };
}

interface ProblemDetailResponse {
  data?: Semantics | null;
}

function MarkList({ label, edges }: { label: string; edges: MarkEdge[] }) {
  if (edges.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {edges.map(edge => (
          <li
            key={`${edge.mark.stable_key}-${edge.part_index ?? 'all'}`}
            className="rounded-full bg-amber-100/80 px-2.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
            title={edge.mark.stable_key}
          >
            {edge.mark.name}
            {edge.part_index ? ` (${edge.part_index})` : ''}
            {edge.evidence && (
              <details className="mt-1 whitespace-normal">
                <summary className="cursor-pointer">
                  {edge.evidence.rationale}
                </summary>
                <blockquote>{edge.evidence.problem_quote}</blockquote>
                <blockquote>{edge.evidence.document_quote}</blockquote>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Surfaces the Problem Mark projection. The data is already produced by the
// annotation pipeline and returned by GET /api/problems/[id]; before this it had
// no reader anywhere in the UI.
export function ProblemMarksCard({ problemId }: { problemId: string }) {
  const t = useTranslations('Problems');
  const [semantics, setSemantics] = useState<Semantics | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    async function load() {
      try {
        const payload = await apiGet<ProblemDetailResponse>(
          `/api/problems/${problemId}/marks`
        );
        if (cancelled) return;
        setSemantics(payload.data ?? null);
        if (
          payload.data?.annotation_status === 'pending' &&
          Date.now() - started < 310000
        )
          timer = setTimeout(load, 5000);
      } catch {
        /* Keep the last accepted projection on a transient read failure. */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [problemId, retryVersion]);

  async function retry() {
    setRetrying(true);
    setRetryError(false);
    try {
      await apiPost(`/api/problems/${problemId}/marks`, {});
    } catch {
      setRetryError(true);
    } finally {
      setRetrying(false);
      setRetryVersion(v => v + 1);
    }
  }

  if (!loaded) return null;

  const hasMarks =
    !!semantics &&
    (semantics.targets.length > 0 ||
      semantics.required.knowledge.length > 0 ||
      semantics.required.skills.length > 0 ||
      (semantics.methods?.recommended.length ?? 0) > 0 ||
      (semantics.methods?.alternative.length ?? 0) > 0);

  const status = semantics?.annotation_status;
  const message =
    status === 'pending'
      ? t('marksPending')
      : status === 'failed'
        ? t('marksFailed')
        : status === 'unresolved'
          ? t('marksUnresolved')
          : !hasMarks
            ? t('marksEmpty')
            : null;

  return (
    <section className="rounded-2xl border border-amber-200/40 bg-white/60 p-4 dark:border-gray-800/50 dark:bg-gray-900/40">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
        {t('marksTitle')}
      </h2>
      {message && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {message}
        </p>
      )}
      {(status === 'failed' || status === 'unresolved') && (
        <button
          type="button"
          className="mt-2 text-xs underline"
          disabled={retrying}
          onClick={() => void retry()}
        >
          {t('marksRetry')}
        </button>
      )}
      {retryError && (
        <p role="status" className="text-xs text-gray-500">
          {t('marksRetryFailed')}
        </p>
      )}
      {semantics && (
        <div className="mt-2 space-y-2">
          <MarkList
            label={t('marksRecommended')}
            edges={semantics!.methods?.recommended ?? []}
          />
          <MarkList
            label={t('marksAlternative')}
            edges={semantics!.methods?.alternative ?? []}
          />
          <MarkList label={t('marksTarget')} edges={semantics!.targets} />
          <MarkList
            label={`${t('marksRequired')} · ${t('marksKnowledge')}`}
            edges={semantics!.required.knowledge}
          />
          <MarkList
            label={`${t('marksRequired')} · ${t('marksSkill')}`}
            edges={semantics!.required.skills}
          />
        </div>
      )}
    </section>
  );
}

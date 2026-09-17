'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiGet } from '@/lib/api-client';

interface MarkEdge {
  part_index: number | null;
  mark: { stable_key: string; name: string; kind: 'knowledge' | 'skill' };
}

interface Semantics {
  annotation_status: 'pending' | 'resolved' | 'unresolved' | 'failed';
  targets: MarkEdge[];
  required: { knowledge: MarkEdge[]; skills: MarkEdge[] };
}

interface ProblemDetailResponse {
  data?: { semantics?: Semantics | null };
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

  useEffect(() => {
    let cancelled = false;
    apiGet<ProblemDetailResponse>(`/api/problems/${problemId}`)
      .then(payload => {
        if (!cancelled) setSemantics(payload.data?.semantics ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [problemId]);

  if (!loaded) return null;

  const hasMarks =
    !!semantics &&
    (semantics.targets.length > 0 ||
      semantics.required.knowledge.length > 0 ||
      semantics.required.skills.length > 0);

  if (!hasMarks) {
    return (
      <section className="rounded-2xl border border-amber-200/40 bg-white/60 p-4 dark:border-gray-800/50 dark:bg-gray-900/40">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          {t('marksTitle')}
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {semantics?.annotation_status === 'pending'
            ? t('marksPending')
            : t('marksEmpty')}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-amber-200/40 bg-white/60 p-4 dark:border-gray-800/50 dark:bg-gray-900/40">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
        {t('marksTitle')}
      </h2>
      <div className="mt-2 space-y-2">
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
    </section>
  );
}

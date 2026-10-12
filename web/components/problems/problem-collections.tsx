'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { appendFromParam } from '@/lib/navigation-context';
import type { Problem } from '@/lib/types';

export function ProblemCollections({ problem }: { problem: Problem }) {
  const t = useTranslations('Problems');
  if (!problem.collections) return null;
  return (
    <p
      className="text-xs text-muted-foreground"
      onClick={event => event.stopPropagation()}
    >
      {problem.collections.length === 0 ? (
        t('notCollected')
      ) : (
        <>
          {t('collectedIn')}{' '}
          {problem.collections.map((collection, index) => (
            <span key={collection.id}>
              {index > 0 ? ', ' : ''}
              <Link
                className="underline"
                href={appendFromParam(
                  `/problem-sets/${collection.id}`,
                  `/subjects/${problem.subject_id}/problems`
                )}
              >
                {collection.name}
              </Link>
            </span>
          ))}
        </>
      )}
    </p>
  );
}

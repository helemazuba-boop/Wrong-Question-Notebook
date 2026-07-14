'use client';

import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { BackLink } from '@/components/back-link';
import EnhancedProblemsTable from '../../../subjects/[id]/problems/enhanced-problems-table';
import { AddProblemsToSetClientProps } from '@/lib/types';
import { appendFromParam } from '@/lib/navigation-context';

export default function AddProblemsToSetClient({
  problemSet,
  problems,
  tagsByProblem,
  availableTags,
  problemSetProblemIds,
  fromHref,
}: AddProblemsToSetClientProps) {
  const t = useTranslations('ProblemSets');
  const router = useRouter();
  const backToSetHref = appendFromParam(
    `/problem-sets/${problemSet.id}`,
    fromHref
  );

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('addProblemsToSet')}</h1>
          <p className="text-muted-foreground">
            Add problems from <strong>{problemSet.subject_name}</strong> to{' '}
            <strong>&quot;{problemSet.name}&quot;</strong>
          </p>
        </div>
        <BackLink onClick={() => router.push(backToSetHref)}>
          Back to Problem Set
        </BackLink>
      </div>

      {/* Problems Table - Reuse EnhancedProblemsTable with restrictions */}
      <EnhancedProblemsTable
        initialProblems={problems}
        initialTagsByProblem={tagsByProblem}
        subjectId={problemSet.subject_id}
        availableTags={availableTags}
        onProblemDeleted={null} // Disable deletion
        problemSetProblemIds={problemSetProblemIds} // Pass existing problem IDs
        isAddToSetMode={true} // Flag to indicate this is add-to-set mode
        targetProblemSetId={problemSet.id} // Pass the target problem set ID
        returnToProblemSetHref={backToSetHref}
      />
    </div>
  );
}

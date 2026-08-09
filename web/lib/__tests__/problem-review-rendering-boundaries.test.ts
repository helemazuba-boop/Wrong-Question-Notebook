import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const webRoot = path.resolve(__dirname, '../..');
const formSource = readFileSync(
  path.join(webRoot, 'components/review/attempt-status-form.tsx'),
  'utf8'
);
const reviewSource = readFileSync(
  path.join(
    webRoot,
    'app/[locale]/(app)/subjects/[id]/problems/[problemId]/review/problem-review.tsx'
  ),
  'utf8'
);

const diagnosticsSource = readFileSync(
  path.join(webRoot, 'components/review/scheduler-diagnostics.tsx'),
  'utf8'
);

describe('human Review rendering boundaries', () => {
  it('locks Rating until the answer and solution gates have passed', () => {
    expect(formSource).toContain(
      'const isRatingLocked = isPreAttempt || !solutionRevealed;'
    );
    expect(formSource).toContain('if (isRatingLocked && !isSaved)');
    expect(reviewSource).toContain('solutionRevealed={showSolution}');
  });

  it('renders the initial idea only in the durable saved branch', () => {
    const savedBranch = formSource.indexOf('if (isSaved && savedState)');
    const initialIdea = formSource.indexOf('{initialIdea ? (');
    const unsavedBranch = formSource.lastIndexOf('return (');

    expect(savedBranch).toBeGreaterThan(-1);
    expect(initialIdea).toBeGreaterThan(savedBranch);
    expect(initialIdea).toBeLessThan(unsavedBranch);
  });

  it('keeps Review reflection optional after Rating durability', () => {
    expect(reviewSource).toContain(
      'Session completion follows the durable Rating Event. Reflection remains'
    );
    expect(formSource).toContain("apiUrl('/api/problem-reviews/idea')");
    expect(
      formSource.indexOf("apiUrl('/api/problem-reviews/idea')")
    ).toBeGreaterThan(formSource.indexOf("apiUrl('/api/problem-reviews')"));
  });

  it('mounts owner diagnostics only after durable Rating and outside read-only Review', () => {
    expect(reviewSource).toContain('!isReadOnly && hasDurableRating && (');
    expect(reviewSource).toContain(
      '<SchedulerDiagnostics problemId={problem.id} />'
    );
    expect(diagnosticsSource).toContain(
      'apiUrl(`/api/problems/${problemId}/review-scheduler-diagnostics`)'
    );
    expect(diagnosticsSource).not.toContain('createServiceClient');
    expect(diagnosticsSource).not.toMatch(
      /card_before|review_log|card_after|lease_token/
    );
  });

  it('persists ambiguous request identity in session storage', () => {
    expect(formSource).toContain("'wqn:pending-review-rating:v1:'");
    expect(formSource).toContain('window.sessionStorage.setItem');
    expect(formSource).toContain('window.sessionStorage.getItem');
    expect(formSource).toContain('reviewOccurrenceId:');
    expect(formSource).toContain('requestId: newRequestId()');
  });
});

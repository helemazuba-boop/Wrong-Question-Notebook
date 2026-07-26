'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { BackLink } from '@/components/back-link';
import { ProblemStatus } from '@/lib/schemas';
import { getProblemTypeDisplayName, getPartTypes } from '@/lib/common-utils';
import { problemHasAutoMark, isPartAutoMarkable } from '@/lib/answer-marking';
import { RichTextDisplay } from '@/components/ui/rich-text-display';
import AnswerInput from './answer-input';
import SolutionReveal from './solution-reveal';
import AttemptStatusForm from '@/components/review/attempt-status-form';
import ReviewSessionNav from '@/components/review/review-session-nav';
import AttemptTimeline from '@/components/reflection/attempt-timeline';
import { Problem, Subject, PartResult, ProblemPart } from '@/lib/types';
import { useOnboarding } from '@/components/onboarding/onboarding-provider';
import {
  BookOpen,
  BookPlus,
  PencilLine,
  Tag,
  ChevronLeft,
  ChevronRight,
  LogOut,
} from 'lucide-react';
import CopyProblemDialog from '@/components/copy-problem-dialog';
import PrintDialog from './print-dialog';

interface AllProblem {
  id: string;
  title: string;
  status: ProblemStatus;
}

interface SessionNavProps {
  currentIndex: number;
  totalProblems: number;
  completedCount: number;
  skippedCount: number;
  onPrevious: () => void;
  onNext: () => void;
  onSkip: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  nextEnabled?: boolean;
  isLastProblem?: boolean;
  onFinish?: () => void;
  isForemost?: boolean;
  elapsedMs?: number;
  onPause?: () => void;
}

export interface AttemptState {
  /** Per-part answers keyed by part index. */
  submittedAnswer: any;
  isCorrect: boolean | null;
  partResults?: PartResult[] | null;
  totalScore?: number | null;
  totalFullMarks?: number | null;
  attemptId: string | null;
  selectedStatus?: ProblemStatus | null;
  formSaved?: boolean;
  cause?: string | null;
  reflectionNotes?: string | null;
  submittedResponse?: string | null;
  needsReviewIsCorrect?: boolean | null;
}

interface ProblemReviewProps {
  problem: Problem;
  subject: Subject;
  allProblems: AllProblem[];
  prevProblem?: AllProblem | null;
  nextProblem?: AllProblem | null;
  isProblemSetMode?: boolean;
  problemSetId?: string;
  isReadOnly?: boolean;
  /** Hide the built-in bottom navigation (session mode uses its own nav) */
  hideNavigation?: boolean;
  /** Called when the user saves the assessment form */
  onFormSaved?: (status: ProblemStatus) => void;
  /** Optional exit session button (for review sessions) */
  showExitButton?: boolean;
  onExitSession?: () => void;
  /** Optional session navigation props (for review sessions) */
  sessionNav?: SessionNavProps;
  /** Restored attempt state when navigating back to a previously attempted problem */
  initialAttemptState?: AttemptState;
  /** Called when an attempt is recorded, so the parent can cache it */
  onAttemptRecorded?: (problemId: string, state: AttemptState) => void;
  /** Whether copying is allowed (for shared problem sets) */
  allowCopying?: boolean;
  /** Problem set ID for copy-problem API (when viewing a shared set) */
  copyProblemSetId?: string;
  /** Whether the current viewer is authenticated */
  isAuthenticated?: boolean;
  /** Explicit destination for the built-in back link. */
  backHref?: string;
  /** Original list/source route to keep when navigating inside a problem set. */
  fromHref?: string;
}

export default function ProblemReview({
  problem,
  subject,
  allProblems,
  prevProblem,
  nextProblem,
  isProblemSetMode = false,
  problemSetId,
  isReadOnly = false,
  hideNavigation = false,
  onFormSaved,
  showExitButton = false,
  onExitSession,
  sessionNav,
  initialAttemptState,
  onAttemptRecorded,
  allowCopying,
  copyProblemSetId,
  isAuthenticated = true,
  backHref,
  fromHref,
}: ProblemReviewProps) {
  const tProblemSets = useTranslations('ProblemSets');
  const tProblems = useTranslations('Problems');
  const t = useTranslations('Common');
  const router = useRouter();
  const { refreshChecklistStatus } = useOnboarding();
  // Shell model: one answer per part, keyed by part index.
  const [answers, setAnswers] = useState<Record<number, any>>({});
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<
    number,
    any
  > | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [partResults, setPartResults] = useState<PartResult[] | null>(null);
  const [totalScore, setTotalScore] = useState<number | null>(null);
  const [totalFullMarks, setTotalFullMarks] = useState<number | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [lastAttemptId, setLastAttemptId] = useState<string | null>(null);
  const [lastAttemptCorrect, setLastAttemptCorrect] = useState<boolean | null>(
    null
  );
  const [hasRecordedAttempt, setHasRecordedAttempt] = useState(false);
  const [timelineRefreshKey, setTimelineRefreshKey] = useState(0);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);

  // Tracks the current problem so in-flight requests from a previous
  // problem are discarded when the response arrives.
  const activeProblemIdRef = useRef(problem.id);

  // Capture initialAttemptState in a ref so the effect below doesn't
  // re-run when the object reference changes between renders.
  const initialAttemptRef = useRef(initialAttemptState);
  initialAttemptRef.current = initialAttemptState;

  // Reset review state and scroll to top when problem changes.
  // If initialAttemptState is provided (navigating back to a previously
  // attempted problem), restore from it instead of blanking.
  useEffect(() => {
    activeProblemIdRef.current = problem.id;
    const cached = initialAttemptRef.current;
    setAnswers(cached?.submittedAnswer ?? {});
    setSubmittedAnswers(cached?.submittedAnswer ?? null);
    setIsCorrect(cached?.isCorrect ?? null);
    setPartResults(cached?.partResults ?? null);
    setTotalScore(cached?.totalScore ?? null);
    setTotalFullMarks(cached?.totalFullMarks ?? null);
    setShowSolution(false);
    setIsSubmitting(false);
    setError(null);
    setHasRecordedAttempt(!!cached?.attemptId);
    setLastAttemptId(cached?.attemptId ?? null);
    setLastAttemptCorrect(cached?.isCorrect ?? null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [problem.id]);

  // Force KaTeX to render before printing, so math is visible on paper.
  useEffect(() => {
    const renderKatex = () => {
      import('katex').then(({ default: katex }) => {
        document
          .querySelectorAll(
            '[data-type="inline-math"], [data-type="block-math"]'
          )
          .forEach(el => {
            const latex = el.getAttribute('data-latex') || el.textContent || '';
            const displayMode = el.getAttribute('data-type') === 'block-math';
            if (!el.querySelector('.katex')) {
              el.innerHTML = katex.renderToString(latex, {
                displayMode,
                throwOnError: false,
              });
            }
          });
      });
    };
    window.addEventListener('beforeprint', renderKatex);
    return () => window.removeEventListener('beforeprint', renderKatex);
  }, []);

  // Get current problem index for navigation
  const currentIndex = allProblems.findIndex(p => p.id === problem.id);
  const effectivePrevProblem = isProblemSetMode
    ? prevProblem
    : currentIndex > 0
      ? allProblems[currentIndex - 1]
      : null;
  const effectiveNextProblem = isProblemSetMode
    ? nextProblem
    : currentIndex < allProblems.length - 1
      ? allProblems[currentIndex + 1]
      : null;

  const parts: ProblemPart[] = Array.isArray(problem.parts)
    ? problem.parts
    : [];
  const autoMarkable = problemHasAutoMark(parts);
  const isAnswerEmpty = (value: any) =>
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  const hasMarkableAnswer = parts.some(
    part => isPartAutoMarkable(part) && !isAnswerEmpty(answers[part.index])
  );
  const partResultByIndex = new Map(
    (partResults ?? []).map(result => [result.index, result])
  );

  const handleAnswerSubmit = async () => {
    if (!autoMarkable) return;

    const submittingProblemId = problem.id;
    const isFirstAttempt = !hasRecordedAttempt;
    const answersPayload = parts
      .filter(part => !isAnswerEmpty(answers[part.index]))
      .map(part => ({ index: part.index, answer: answers[part.index] }));
    if (answersPayload.length === 0) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/problems/${submittingProblemId}/attempt`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            answers: answersPayload,
            record: isFirstAttempt && !isReadOnly,
          }),
        }
      );

      const result = await response.json();

      // Discard stale response if user navigated to a different problem
      if (activeProblemIdRef.current !== submittingProblemId) return;

      if (!response.ok) {
        throw new Error(result.error || 'Failed to submit answer');
      }

      setSubmittedAnswers({ ...answers });
      setIsCorrect(result.data.is_correct);
      setPartResults(result.data.part_results ?? null);
      setTotalScore(result.data.total_score ?? null);
      setTotalFullMarks(result.data.total_full_marks ?? null);

      // Capture attempt info for reflection (only on first attempt)
      if (isFirstAttempt && result.data.data?.id) {
        setLastAttemptId(result.data.data.id);
        setLastAttemptCorrect(result.data.is_correct);
        setHasRecordedAttempt(true);
        setTimelineRefreshKey(k => k + 1);

        // Notify parent so it can cache the attempt state
        onAttemptRecorded?.(submittingProblemId, {
          submittedAnswer: { ...answers },
          isCorrect: result.data.is_correct,
          partResults: result.data.part_results ?? null,
          totalScore: result.data.total_score ?? null,
          totalFullMarks: result.data.total_full_marks ?? null,
          attemptId: result.data.data.id,
        });
      }
    } catch (err: any) {
      if (activeProblemIdRef.current !== submittingProblemId) return;
      setError(err.message);
    } finally {
      if (activeProblemIdRef.current === submittingProblemId) {
        setIsSubmitting(false);
      }
    }
  };

  const handleFormSaved = (
    status: ProblemStatus,
    attemptId: string,
    details?: {
      cause?: string | null;
      reflectionNotes?: string | null;
      submittedResponse?: string | null;
      needsReviewIsCorrect?: boolean | null;
    }
  ) => {
    setTimelineRefreshKey(k => k + 1);
    onFormSaved?.(status);
    refreshChecklistStatus();
    router.refresh();

    // Update attempt cache with form saved state
    onAttemptRecorded?.(problem.id, {
      submittedAnswer: submittedAnswers,
      isCorrect: lastAttemptCorrect,
      partResults: partResults,
      totalScore: totalScore,
      totalFullMarks: totalFullMarks,
      attemptId: attemptId,
      selectedStatus: status,
      formSaved: true,
      cause: details?.cause ?? null,
      reflectionNotes: details?.reflectionNotes ?? null,
      submittedResponse: details?.submittedResponse ?? null,
      needsReviewIsCorrect: details?.needsReviewIsCorrect ?? null,
    });
  };

  const navigateToProblem = (problemId: string) => {
    if (isProblemSetMode && problemSetId) {
      router.push(
        `/problem-sets/${problemSetId}/review?problemId=${problemId}${
          fromHref ? `&from=${encodeURIComponent(fromHref)}` : ''
        }`
      );
    } else {
      router.push(`/subjects/${subject.id}/problems/${problemId}/review`);
    }
  };

  // Build initialSavedState for AttemptStatusForm from cached state
  const formInitialSavedState =
    initialAttemptState?.formSaved && initialAttemptState?.selectedStatus
      ? {
          selectedStatus: initialAttemptState.selectedStatus,
          attemptId: initialAttemptState.attemptId!,
          cause: initialAttemptState.cause ?? null,
          reflectionNotes: initialAttemptState.reflectionNotes ?? null,
          submittedResponse: initialAttemptState.submittedResponse ?? null,
          needsReviewIsCorrect:
            initialAttemptState.needsReviewIsCorrect ?? null,
        }
      : null;

  return (
    <div className="space-y-4">
      {/* Print-only header: name / date / subject */}
      <div className="print-header">
        <span className="font-semibold">错题练习卷</span>
        <span className="text-sm">
          姓名：__________ &nbsp;&nbsp; 班级：__________ &nbsp;&nbsp;{' '}
          {subject.name}
        </span>
      </div>

      {/* Sticky Header with gradient */}
      <div className="review-header-sticky">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Title + metadata */}
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-900 dark:text-white">
              {problem.title}
            </h1>
            <p className="text-xs text-muted-foreground">
              {subject.name} •{' '}
              {getPartTypes(parts)
                .map(type => tProblems(getProblemTypeDisplayName(type)))
                .join(' · ')}
              {parts.length > 1
                ? ` • ${tProblems('partsCount', { count: parts.length })}`
                : ''}
            </p>
          </div>

          {/* Actions: inline tags + toggle button + exit/back link */}
          <div className="flex flex-wrap items-center gap-2">
            <PrintDialog
              problem={problem}
              subject={subject}
              showSolution={showSolution}
              setShowSolution={setShowSolution}
            />
            {/* Tags appear inline to the left of the button when expanded */}
            {problem.tags && problem.tags.length > 0 && (
              <div
                className={`flex flex-wrap gap-1.5 max-w-full sm:max-w-md transition-all duration-300 ease-in-out ${
                  tagsExpanded
                    ? 'opacity-100 translate-x-0 max-h-20'
                    : 'opacity-0 -translate-x-2 max-h-0 overflow-hidden'
                }`}
              >
                {problem.tags.map(tag => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center rounded-full border border-amber-200 dark:border-amber-800 bg-amber-100/60 dark:bg-amber-900/30 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300"
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
            {problem.tags && problem.tags.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTagsExpanded(!tagsExpanded)}
              >
                <Tag className="h-4 w-4" aria-label="Toggle tags visibility" />
                {t('tags')}
              </Button>
            )}
            {showExitButton && onExitSession && (
              <Button variant="ghost" size="sm" onClick={onExitSession}>
                <LogOut className="h-4 w-4 mr-1" />
                {tProblemSets('exitSession')}
              </Button>
            )}
            {!showExitButton && (
              <BackLink
                href={
                  isProblemSetMode
                    ? backHref || `/problem-sets/${problemSetId}`
                    : `/subjects/${subject.id}/problems`
                }
              >
                {isProblemSetMode
                  ? tProblemSets('backToSet')
                  : tProblems('backToProblems')}
              </BackLink>
            )}
          </div>
        </div>
      </div>

      {/* Two-column grid (desktop) / Stack (mobile) */}
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        {/* LEFT COLUMN */}
        <div className="space-y-4">
          {/* Combined Problem + Answer Card (BLUE gradient) */}
          <div className="review-section-blue">
            {/* Problem Section */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="review-icon-small bg-blue-500/10 dark:bg-blue-500/20">
                  <BookOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                </div>
                <h2 className="text-base font-semibold text-blue-900 dark:text-blue-100">
                  {tProblems('problem')}
                </h2>
              </div>
              {problem.content && (
                <div className="prose max-w-none pl-10 rich-text-content">
                  <RichTextDisplay content={problem.content} />
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="border-t border-blue-200/30 dark:border-blue-800/20 my-4" />

            {/* Print: inline answer area (题下 mode) */}
            <div className="print-answer-inline">
              <span className="print-answer-inline-label">答案：</span>
              <div className="print-answer-inline-line" />
            </div>
            {parts
              .filter(
                part =>
                  part.answer_config?.type === 'mcq' ||
                  part.answer_config?.type === 'multi_mcq'
              )
              .map(part => {
                const config = part.answer_config!;
                const correctIds =
                  config.type === 'mcq'
                    ? [config.correct_choice_id]
                    : config.type === 'multi_mcq'
                      ? config.correct_choice_ids
                      : [];
                return (
                  <div
                    key={part.index}
                    className="print-mcq-inline-answer print-answer-inline"
                  >
                    {parts.length > 1
                      ? `${part.label || `(${part.index})`} `
                      : ''}
                    正确选项：{correctIds.join(', ')}
                  </div>
                );
              })}

            {/* Answer Section */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="review-icon-small bg-blue-500/10 dark:bg-blue-500/20">
                  <PencilLine className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                </div>
                <h2 className="text-base font-semibold text-blue-900 dark:text-blue-100">
                  {tProblems('yourAnswer')}
                </h2>
              </div>

              {!autoMarkable && (
                <div className="ml-10 mb-4 p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-md">
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    {tProblems('manualReviewRequired')}
                  </p>
                </div>
              )}

              <div className="pl-10 space-y-4">
                {parts.map(part => {
                  const result = partResultByIndex.get(part.index);
                  const config = part.answer_config;
                  const isChoicePart =
                    config?.type === 'mcq' || config?.type === 'multi_mcq';
                  return (
                    <div key={`${problem.id}-${part.index}`}>
                      {parts.length > 1 && (
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-900 dark:text-blue-100">
                          <span>{part.label || `(${part.index})`}</span>
                          <span className="text-xs text-muted-foreground">
                            {tProblems(getProblemTypeDisplayName(part.type))}
                            {part.full_marks !== undefined
                              ? ` · ${part.full_marks}分`
                              : ''}
                          </span>
                          {submittedAnswers !== null && result && (
                            <span
                              className={`text-xs font-semibold ${
                                result.correct === null
                                  ? 'text-muted-foreground'
                                  : result.correct
                                    ? 'text-green-600 dark:text-green-400'
                                    : 'text-red-600 dark:text-red-400'
                              }`}
                            >
                              {result.correct === null
                                ? tProblems('pendingSelfAssessment')
                                : result.correct
                                  ? '✓'
                                  : '✗'}
                              {result.score !== undefined
                                ? ` ${result.score}分`
                                : ''}
                            </span>
                          )}
                        </div>
                      )}
                      {part.content && (
                        <div className="prose max-w-none rich-text-content mb-2">
                          <RichTextDisplay content={part.content} />
                        </div>
                      )}
                      <AnswerInput
                        part={part}
                        value={
                          answers[part.index] ?? (isChoicePart ? undefined : '')
                        }
                        onChange={value =>
                          setAnswers(previous => ({
                            ...previous,
                            [part.index]: value,
                          }))
                        }
                        onSubmit={autoMarkable ? handleAnswerSubmit : undefined}
                        disabled={
                          isSubmitting ||
                          (autoMarkable &&
                            submittedAnswers !== null &&
                            isCorrect === true)
                        }
                        hideChoiceIds={
                          submittedAnswers === null &&
                          !showSolution &&
                          isChoicePart &&
                          config?.randomize_choices !== false
                        }
                      />
                    </div>
                  );
                })}

                <div className="mt-4 flex gap-3">
                  {autoMarkable && (
                    <Button
                      onClick={handleAnswerSubmit}
                      disabled={
                        isSubmitting ||
                        !hasMarkableAnswer ||
                        (submittedAnswers !== null && isCorrect === true)
                      }
                    >
                      {isSubmitting
                        ? t('submitting')
                        : submittedAnswers !== null && isCorrect === false
                          ? tProblems('resubmitAnswer')
                          : tProblems('submitAnswer')}
                    </Button>
                  )}

                  {!autoMarkable &&
                    Object.values(answers).some(
                      value => !isAnswerEmpty(value)
                    ) &&
                    parts.some(part => part.correct_answer) && (
                      <Button
                        onClick={() => setShowSolution(true)}
                        className="bg-green-600 dark:bg-green-700 text-white hover:bg-green-700 dark:hover:bg-green-600"
                      >
                        {tProblems('viewSolution')}
                      </Button>
                    )}
                </div>

                {/* Answer Feedback */}
                {submittedAnswers !== null && isCorrect !== null && (
                  <div
                    className={`mt-4 p-4 rounded-md ${
                      isCorrect
                        ? 'bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800'
                        : 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-lg ${isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                      >
                        {isCorrect ? '✓' : '✗'}
                      </span>
                      <span
                        className={`font-medium ${isCorrect ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'}`}
                      >
                        {isCorrect
                          ? tProblems('correct')
                          : tProblems('incorrect')}
                      </span>
                    </div>
                    {totalScore !== null && totalFullMarks !== null && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {tProblems('partScoreSummary', {
                          score: totalScore,
                          total: totalFullMarks,
                        })}
                      </p>
                    )}
                    {!isCorrect &&
                      (partResults ?? []).some(
                        result => result.correct === false
                      ) && (
                        <p className="text-sm text-muted-foreground mt-1">
                          {tProblems('wrongPartsLabel', {
                            parts: (partResults ?? [])
                              .filter(result => result.correct === false)
                              .map(result => {
                                const part = parts.find(
                                  p => p.index === result.index
                                );
                                return part?.label || `(${result.index})`;
                              })
                              .join(' '),
                          })}
                        </p>
                      )}
                    {!isCorrect && autoMarkable && (
                      <p className="text-sm text-red-600 dark:text-red-400 mt-2">
                        {tProblems('tryAgain')}
                      </p>
                    )}
                  </div>
                )}

                {error && (
                  <div className="mt-4 p-4 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-md">
                    <p className="text-red-800 dark:text-red-200 text-sm">
                      {error}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Solution Card (GREEN gradient) */}
          <div
            className="rounded-2xl overflow-hidden border border-green-200/40 dark:border-green-800/30"
            data-print-hide="true"
          >
            <SolutionReveal
              solutionText={problem.solution_text || undefined}
              solutionAssets={problem.solution_assets || []}
              parts={parts}
              isRevealed={showSolution}
              onToggle={() => setShowSolution(!showSolution)}
              wrapperClassName="bg-gradient-to-br from-green-50 to-emerald-100/50 dark:from-green-950/40 dark:to-emerald-900/20 p-4"
            />
          </div>

          {/* Print-only: answer appendix (末尾 mode) */}
          <div className="print-answer-appendix">
            <h2>参考答案</h2>
            <div className="print-answer-appendix-item">
              <strong>题目：</strong>
              {parts.some(part => part.answer_config || part.correct_answer) ? (
                <span>
                  {parts.map(part => {
                    const config = part.answer_config;
                    let answerText: string | null = null;
                    if (config?.type === 'mcq') {
                      answerText = config.correct_choice_id;
                    } else if (config?.type === 'multi_mcq') {
                      answerText = config.correct_choice_ids.join(', ');
                    } else if (part.correct_answer) {
                      answerText = part.correct_answer;
                    }
                    if (!answerText) return null;
                    return (
                      <span key={part.index} className="mr-3 font-mono">
                        {parts.length > 1
                          ? `${part.label || `(${part.index})`} `
                          : ''}
                        {answerText}
                      </span>
                    );
                  })}
                </span>
              ) : (
                '—'
              )}
            </div>
          </div>

          {/* Print-only: solution appendix (末尾 mode) */}
          {problem.solution_text && (
            <div className="print-solution-appendix">
              <h2 className="text-base font-bold mb-2">解题思路</h2>
              <div className="prose max-w-none rich-text-content text-sm">
                <RichTextDisplay content={problem.solution_text} />
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN - Sticky Sidebar */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {/* Assessment Form (AMBER gradient) */}
          {!isReadOnly && (
            <div className="review-section-amber">
              <AttemptStatusForm
                problemId={problem.id}
                currentStatus={problem.status}
                autoMark={autoMarkable}
                attemptId={lastAttemptId}
                autoMarkCorrect={lastAttemptCorrect}
                hasSubmitted={submittedAnswers !== null}
                onSaved={handleFormSaved}
                initialSavedState={formInitialSavedState}
                disabled={isReadOnly}
              />
            </div>
          )}

          {/* Add to Notebook (shared problem set viewers) */}
          {isReadOnly && allowCopying && copyProblemSetId && (
            <div className="review-section-amber">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  if (isAuthenticated) {
                    setCopyDialogOpen(true);
                  } else {
                    const redirectHref = `/problem-sets/${copyProblemSetId}/review?problemId=${problem.id}${
                      fromHref ? `&from=${encodeURIComponent(fromHref)}` : ''
                    }`;
                    router.push(
                      `/auth/sign-up?redirect=${encodeURIComponent(redirectHref)}`
                    );
                  }
                }}
              >
                <BookPlus className="h-4 w-4 mr-2" />
                {isAuthenticated
                  ? tProblems('addToNotebook')
                  : tProblems('signUpToSave')}
              </Button>
            </div>
          )}

          {/* Session Navigation or Regular Navigation */}
          {sessionNav ? (
            /* Session Navigation with ROSE gradient styling */
            <ReviewSessionNav
              {...sessionNav}
              wrapperClassName="space-y-3 bg-gradient-to-br from-rose-50 to-pink-100/50 dark:from-rose-950/40 dark:to-pink-900/20 rounded-2xl p-4 border border-rose-200/40 dark:border-rose-800/30"
            />
          ) : (
            /* Regular Navigation (ROSE gradient) */
            !hideNavigation && (
              <div className="review-section-rose">
                <div className="text-xs text-muted-foreground mb-2 text-center">
                  {tProblems('problemOf', {
                    current: currentIndex + 1,
                    total: allProblems.length,
                  })}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    disabled={!effectivePrevProblem}
                    onClick={() =>
                      effectivePrevProblem &&
                      navigateToProblem(effectivePrevProblem.id)
                    }
                    aria-label="Previous problem"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    disabled={!effectiveNextProblem}
                    onClick={() =>
                      effectiveNextProblem &&
                      navigateToProblem(effectiveNextProblem.id)
                    }
                    aria-label="Next problem"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )
          )}

          {/* Attempt History Timeline (VIOLET gradient) */}
          {!isReadOnly && (
            <AttemptTimeline
              problemId={problem.id}
              refreshKey={timelineRefreshKey}
            />
          )}
        </div>
      </div>

      {/* Copy Problem Dialog */}
      {isReadOnly && allowCopying && copyProblemSetId && (
        <CopyProblemDialog
          open={copyDialogOpen}
          onOpenChange={setCopyDialogOpen}
          problemSetId={copyProblemSetId}
          problemId={problem.id}
          problemTitle={problem.title}
        />
      )}
    </div>
  );
}

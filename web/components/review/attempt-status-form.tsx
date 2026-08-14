'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Pencil,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiUrl } from '@/lib/api-utils';
import type { HumanRating } from '@/lib/fsrs/schemas';
import type { ProblemStatus } from '@/lib/schemas';
import { cn } from '@/lib/utils';

const pendingRequestStoragePrefix = 'wqn:pending-review-rating:v1:';

function pendingRequestStorageKey(problemId: string): string {
  return `${pendingRequestStoragePrefix}${problemId}`;
}

function parsePendingRequest(
  value: string | null
): PendingReviewRatingRequest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PendingReviewRatingRequest>;
    if (
      (parsed.attemptId === null || typeof parsed.attemptId === 'string') &&
      typeof parsed.reviewOccurrenceId === 'string' &&
      typeof parsed.requestId === 'string' &&
      ['Again', 'Hard', 'Good', 'Easy'].includes(String(parsed.rating))
    ) {
      return parsed as PendingReviewRatingRequest;
    }
  } catch {
    // Ignore malformed or stale browser state.
  }
  return null;
}

const ratingOptions = [
  {
    value: 'Again' as const,
    icon: XCircle,
    activeBg:
      'bg-red-100 dark:bg-red-950/20 text-red-800 dark:text-red-200 border-red-300 dark:border-red-800',
    hoverBg:
      'hover:bg-red-50 hover:border-red-200 dark:hover:bg-red-950/10 dark:hover:border-red-900/30',
  },
  {
    value: 'Hard' as const,
    icon: AlertCircle,
    activeBg:
      'bg-orange-100 dark:bg-orange-950/20 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-800',
    hoverBg:
      'hover:bg-orange-50 hover:border-orange-200 dark:hover:bg-orange-950/10 dark:hover:border-orange-900/30',
  },
  {
    value: 'Good' as const,
    icon: CheckCircle,
    activeBg:
      'bg-green-100 dark:bg-green-950/20 text-green-800 dark:text-green-200 border-green-300 dark:border-green-800',
    hoverBg:
      'hover:bg-green-50 hover:border-green-200 dark:hover:bg-green-950/10 dark:hover:border-green-900/30',
  },
  {
    value: 'Easy' as const,
    icon: CheckCircle,
    activeBg:
      'bg-blue-100 dark:bg-blue-950/20 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-800',
    hoverBg:
      'hover:bg-blue-50 hover:border-blue-200 dark:hover:bg-blue-950/10 dark:hover:border-blue-900/30',
  },
];

export interface PendingReviewRatingRequest {
  attemptId: string | null;
  reviewOccurrenceId: string;
  requestId: string;
  rating: HumanRating;
}

export interface SavedReviewRatingState {
  rating: HumanRating;
  attemptId: string;
  reviewOccurrenceId: string;
  terminalEventId: string;
  reviewIdea?: string | null;
}

interface AttemptStatusFormProps {
  problemId: string;
  currentStatus: ProblemStatus;
  autoMark: boolean;
  attemptId?: string | null;
  submittedAnswer?: unknown;
  autoMarkCorrect?: boolean | null;
  hasSubmitted?: boolean;
  solutionRevealed: boolean;
  initialIdea?: string | null;
  onSaved: (state: SavedReviewRatingState) => void;
  onPendingRequestChange?: (request: PendingReviewRatingRequest | null) => void;
  initialPendingRequest?: PendingReviewRatingRequest | null;
  initialSavedState?: SavedReviewRatingState | null;
  disabled?: boolean;
}

function newRequestId() {
  return crypto.randomUUID().replaceAll('-', '');
}

export default function AttemptStatusForm({
  problemId,
  currentStatus,
  autoMark,
  attemptId,
  submittedAnswer,
  autoMarkCorrect,
  hasSubmitted,
  solutionRevealed,
  initialIdea,
  onSaved,
  onPendingRequestChange,
  initialPendingRequest,
  initialSavedState,
  disabled,
}: AttemptStatusFormProps) {
  const t = useTranslations('Review');
  const tCommon = useTranslations('Common');
  const [selectedRating, setSelectedRating] = useState<HumanRating | null>(
    initialSavedState?.rating ?? null
  );
  const [savedState, setSavedState] = useState<SavedReviewRatingState | null>(
    initialSavedState ?? null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [idea, setIdea] = useState(initialSavedState?.reviewIdea ?? '');
  const [isSavingIdea, setIsSavingIdea] = useState(false);
  const [pendingRequest, setPendingRequest] =
    useState<PendingReviewRatingRequest | null>(initialPendingRequest ?? null);
  const isPreAttempt = autoMark && !hasSubmitted;
  const isRatingLocked = isPreAttempt || !solutionRevealed;
  const isSaved = savedState !== null && !isEditing;

  useEffect(() => {
    if (initialPendingRequest || savedState || pendingRequest) return;
    const stored = parsePendingRequest(
      window.sessionStorage.getItem(pendingRequestStorageKey(problemId))
    );
    if (!stored) return;
    setPendingRequest(stored);
    setSelectedRating(stored.rating);
    onPendingRequestChange?.(stored);
  }, [
    initialPendingRequest,
    onPendingRequestChange,
    pendingRequest,
    problemId,
    savedState,
  ]);

  useEffect(() => {
    if (
      !isRatingLocked &&
      !savedState &&
      !selectedRating &&
      autoMarkCorrect !== null &&
      autoMarkCorrect !== undefined
    ) {
      setSelectedRating(autoMarkCorrect ? 'Good' : 'Again');
    }
  }, [autoMarkCorrect, isRatingLocked, savedState, selectedRating]);

  const updatePendingRequest = (request: PendingReviewRatingRequest | null) => {
    setPendingRequest(request);
    if (request) {
      window.sessionStorage.setItem(
        pendingRequestStorageKey(problemId),
        JSON.stringify(request)
      );
    } else {
      window.sessionStorage.removeItem(pendingRequestStorageKey(problemId));
    }
    onPendingRequestChange?.(request);
  };

  const handleSaveRating = async () => {
    if (!selectedRating || isRatingLocked) return;
    setIsSaving(true);
    try {
      const correcting = savedState !== null;
      let request = pendingRequest;
      if (!request || request.rating !== selectedRating) {
        request = {
          attemptId: correcting
            ? savedState.attemptId
            : (attemptId ?? pendingRequest?.attemptId ?? null),
          reviewOccurrenceId:
            savedState?.reviewOccurrenceId ??
            pendingRequest?.reviewOccurrenceId ??
            crypto.randomUUID(),
          requestId: newRequestId(),
          rating: selectedRating,
        };
        updatePendingRequest(request);
      }

      let ratingAttemptId = request.attemptId;
      if (!ratingAttemptId) {
        const attemptResponse = await fetch(apiUrl('/api/attempts'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            problem_id: problemId,
            submitted_answer: submittedAnswer ?? {},
            is_correct: null,
            is_self_assessed: true,
          }),
        });
        const attemptResult = await attemptResponse.json();
        if (!attemptResponse.ok || !attemptResult.data?.id) {
          throw new Error(attemptResult.error || t('failedSaveRating'));
        }
        ratingAttemptId = attemptResult.data.id;
        request = { ...request, attemptId: ratingAttemptId };
        updatePendingRequest(request);
      }
      if (!ratingAttemptId) throw new Error(t('failedSaveRating'));

      const response = await fetch(apiUrl('/api/problem-reviews'), {
        method: correcting ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          correcting
            ? {
                rating: selectedRating,
                review_occurrence_id: request.reviewOccurrenceId,
                terminal_event_id: savedState.terminalEventId,
                request_id: request.requestId,
              }
            : {
                attempt_id: ratingAttemptId,
                rating: selectedRating,
                review_occurrence_id: request.reviewOccurrenceId,
                request_id: request.requestId,
              }
        ),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t('failedSaveRating'));

      const nextState = {
        rating: selectedRating,
        attemptId: ratingAttemptId,
        reviewOccurrenceId: result.data.review_occurrence_id,
        terminalEventId: result.data.event_id,
        reviewIdea: savedState?.reviewIdea ?? null,
      };
      setSavedState(nextState);
      updatePendingRequest(null);
      setIsEditing(false);
      onSaved(nextState);
    } catch {
      toast.error(t('failedSaveRating'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveIdea = async () => {
    if (!savedState) return;
    setIsSavingIdea(true);
    try {
      const normalizedIdea = idea.trim() || null;
      const response = await fetch(apiUrl('/api/problem-reviews/idea'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          review_occurrence_id: savedState.reviewOccurrenceId,
          idea: normalizedIdea,
        }),
      });
      if (!response.ok) throw new Error();
      const nextState = { ...savedState, reviewIdea: normalizedIdea };
      setSavedState(nextState);
      onSaved(nextState);
      toast.success(t('reviewIdeaSaved'));
    } catch {
      toast.error(t('failedSaveReviewIdea'));
    } finally {
      setIsSavingIdea(false);
    }
  };

  if (isRatingLocked && !isSaved) {
    return (
      <div className="pointer-events-none opacity-50">
        <h3 className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
          {t('rating')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {isPreAttempt ? t('submitFirst') : t('revealSolutionFirst')}
        </p>
      </div>
    );
  }

  if (isSaved && savedState) {
    const savedOption = ratingOptions.find(
      option => option.value === savedState.rating
    )!;
    const SavedIcon = savedOption.icon;
    return (
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
            {t('rating')}
          </h3>
          <div
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium',
              savedOption.activeBg
            )}
          >
            <SavedIcon className="h-4 w-4" />
            <span>{t(`rating${savedState.rating}`)}</span>
          </div>
          {!disabled && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 px-2 text-xs"
              onClick={() => {
                setIsEditing(true);
                updatePendingRequest(null);
              }}
            >
              <Pencil className="h-3 w-3" />
              {tCommon('edit')}
            </Button>
          )}
        </div>

        <div className="space-y-2 border-t border-amber-200/60 pt-4 dark:border-amber-800/40">
          <h4 className="text-sm font-semibold">
            {t('reflectionAfterRating')}
          </h4>
          {initialIdea ? (
            <div className="rounded-lg border bg-background/70 p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t('yourInitialIdea')}
              </p>
              <p className="whitespace-pre-wrap text-sm">{initialIdea}</p>
            </div>
          ) : null}
          <Textarea
            value={idea}
            onChange={event => setIdea(event.target.value)}
            maxLength={4000}
            placeholder={t('reviewIdeaPlaceholder')}
            className="min-h-20 resize-y text-sm"
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleSaveIdea}
            disabled={isSavingIdea || disabled}
          >
            {isSavingIdea ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t('saveReviewIdea')
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-amber-900 dark:text-amber-100">
        {t('rating')}
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        {autoMarkCorrect === null || autoMarkCorrect === undefined
          ? t('chooseHumanRating')
          : autoMarkCorrect
            ? t('machineSuggestsGood')
            : t('machineSuggestsAgain')}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {ratingOptions.map(option => {
          const Icon = option.icon;
          return (
            <button
              type="button"
              key={option.value}
              onClick={() => {
                setSelectedRating(option.value);
                if (pendingRequest?.rating !== option.value) {
                  updatePendingRequest(null);
                }
              }}
              disabled={disabled}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-all',
                selectedRating === option.value
                  ? option.activeBg
                  : `border-border bg-background ${option.hoverBg}`
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{t(`rating${option.value}`)}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        {t('currentStatus', {
          status: t(
            currentStatus === 'needs_review' ? 'needsReview' : currentStatus
          ),
        })}
      </p>
      <Button
        onClick={handleSaveRating}
        disabled={!selectedRating || isSaving || disabled}
        size="sm"
        className="mt-3 w-full bg-amber-600 text-white hover:bg-amber-700"
      >
        {isSaving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isEditing ? (
          t('correctRating')
        ) : (
          t('confirmRating')
        )}
      </Button>
    </div>
  );
}

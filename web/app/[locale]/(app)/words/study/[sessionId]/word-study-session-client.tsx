'use client';
import { useTranslations as useFeatureTranslations } from 'next-intl';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  createWebWordRequestId,
  dispositionForPendingObservation,
  parsePendingWebWordObservation,
  pendingWordObservationStorageKey,
  pendingWordSessionStorageKey,
  readWordStudyStorage,
  removeWordStudyStorage,
  writeWordStudyStorage,
  type PendingWebWordObservation,
} from '@/lib/word-study-client';
import type {
  WebWordStudyEntry,
  WebWordStudySessionView,
} from '@/lib/word-study-web';
import type { WordObservationAction } from '@/lib/word-study-v1';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Clock3,
  CloudOff,
  Eye,
  Pause,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

type Props = { initialSession: WebWordStudySessionView };

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
};

type ObservationResult = {
  sequence: number;
  progress: WebWordStudyEntry['progress'] | null;
};

function isRetryableFailure(error: unknown) {
  return (
    error instanceof Error &&
    'retryable' in error &&
    Boolean((error as Error & { retryable?: boolean }).retryable)
  );
}

function apiError(
  result: ApiEnvelope<unknown> | null,
  fallback: string
): Error & { code?: string; retryable?: boolean } {
  return Object.assign(new Error(result?.error?.message || fallback), {
    code: result?.error?.code,
    retryable: Boolean(result?.error?.retryable),
  });
}

export default function WordStudySessionClient({ initialSession }: Props) {
  const tFeature = useFeatureTranslations('Words');
  function modeLabel(mode: WebWordStudySessionView['mode']) {
    if (mode === 'sequential') return tFeature('sequentialStudy');
    if (mode === 'dictionary') return tFeature('dictionaryBrowsing');
    return tFeature('smartReview');
  }
  function statusLabel(status: WebWordStudyEntry['progress']['status']) {
    if (status === 'learning') return tFeature('learning');
    if (status === 'review') return tFeature('review2');
    if (status === 'mastered') return tFeature('mastered');
    return tFeature('newWords');
  }

  const router = useRouter();
  const [session, setSession] = useState(initialSession);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingWebWordObservation | null>(
    null
  );
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [completionBusy, setCompletionBusy] = useState(false);
  const [lastMistake, setLastMistake] =
    useState<WebWordStudyEntry['mistake']>(null);
  const sessionRef = useRef(session);
  const pendingRef = useRef(pending);
  const requestInFlightRef = useRef(false);
  const initialRecoveryRef = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const currentItem =
    session.next_sequence < session.items.length
      ? session.items[session.next_sequence]
      : null;
  const completed =
    session.status === 'completed' ||
    session.next_sequence >= session.candidate_count;
  const expired = Date.parse(session.expires_at) <= Date.now();
  const progressPercent =
    session.candidate_count > 0
      ? Math.min(
          100,
          Math.round((session.next_sequence / session.candidate_count) * 100)
        )
      : 100;

  const heading = useMemo(
    () => session.deck_titles.join('、') || tFeature('vocabularyStudy'),
    [session.deck_titles, tFeature]
  );

  const refreshSession = useCallback(async () => {
    const requestId = createWebWordRequestId('websync');
    const response = await fetch(
      `/api/words/study/sessions/${sessionRef.current.session_id}`,
      {
        cache: 'no-store',
        headers: { 'X-WQN-Request-Id': requestId },
      }
    );
    const result = (await response.json().catch(() => null)) as ApiEnvelope<{
      session: WebWordStudySessionView;
    }> | null;
    if (!response.ok || !result?.ok || !result.data?.session) {
      throw apiError(result, tFeature('couldNotRestoreTheStudySession'));
    }
    setSession(result.data.session);
    return result.data.session;
  }, [tFeature]);

  const updateStatus = useCallback(
    async (status: 'active' | 'paused' | 'completed' | 'abandoned') => {
      const requestId = createWebWordRequestId('webstatus');
      const response = await fetch(
        `/api/words/study/sessions/${sessionRef.current.session_id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: requestId, status }),
        }
      );
      const result = (await response.json().catch(() => null)) as ApiEnvelope<{
        session: Pick<
          WebWordStudySessionView,
          'session_id' | 'status' | 'last_activity_at' | 'expires_at'
        >;
      }> | null;
      if (!response.ok || !result?.ok || !result.data?.session) {
        throw apiError(result, tFeature('couldNotUpdateSessionStatus'));
      }
      setSession(current => ({
        ...current,
        status: result.data!.session.status,
        last_activity_at: result.data!.session.last_activity_at,
        expires_at: result.data!.session.expires_at,
      }));
    },
    [tFeature]
  );

  const completeIfNeeded = useCallback(
    async (nextSequence: number) => {
      if (
        nextSequence < sessionRef.current.candidate_count ||
        sessionRef.current.status === 'completed'
      ) {
        return;
      }
      setCompletionBusy(true);
      try {
        await updateStatus('completed');
        removeWordStudyStorage(localStorage, pendingWordSessionStorageKey());
      } catch {
        setRecoveryMessage(tFeature('allItemsWereSubmittedButCompletionHas'));
      } finally {
        setCompletionBusy(false);
      }
    },
    [updateStatus, tFeature]
  );

  const reconcileWithServer = useCallback(
    async (observation: PendingWebWordObservation) => {
      const latest = await refreshSession();
      const disposition = dispositionForPendingObservation(
        latest.next_sequence,
        observation
      );
      if (disposition === 'already_applied') {
        removeWordStudyStorage(
          localStorage,
          pendingWordObservationStorageKey(observation.session_id)
        );
        pendingRef.current = null;
        setPending(null);
        setRevealed(false);
        setRecoveryMessage(tFeature('anotherPageOrAnEarlierRequestConfirmed'));
        await completeIfNeeded(latest.next_sequence);
        return true;
      }
      if (disposition === 'invalid_gap') {
        removeWordStudyStorage(
          localStorage,
          pendingWordObservationStorageKey(observation.session_id)
        );
        pendingRef.current = null;
        setPending(null);
        setRevealed(false);
        setRecoveryMessage(tFeature('thePendingLocalResultDoesNotMatch'));
        return true;
      }
      return false;
    },
    [completeIfNeeded, refreshSession, tFeature]
  );

  const sendObservation = useCallback(
    async (observation: PendingWebWordObservation) => {
      if (requestInFlightRef.current) return;
      requestInFlightRef.current = true;
      setBusy(true);
      pendingRef.current = observation;
      setPending(observation);
      setRecoveryMessage(null);
      const storageKey = pendingWordObservationStorageKey(
        observation.session_id
      );
      const stored = writeWordStudyStorage(
        localStorage,
        storageKey,
        JSON.stringify(observation)
      );
      if (!stored) {
        setRecoveryMessage(tFeature('theBrowserCannotSaveThePendingResult'));
      }

      try {
        const postObservation = async (value: PendingWebWordObservation) => {
          const endpoint =
            value.action === 'skipped'
              ? '/api/words/study/observations/skip'
              : '/api/words/study/observations';
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
          });
          const result = (await response
            .json()
            .catch(() => null)) as ApiEnvelope<ObservationResult> | null;
          return { response, result };
        };

        let effectiveObservation = observation;
        let { response, result } = await postObservation(effectiveObservation);
        const initialError =
          !response.ok || !result?.ok || !result.data
            ? apiError(result, tFeature('couldNotSubmitTheStudyResult'))
            : null;
        if (
          initialError &&
          observation.action !== 'skipped' &&
          (initialError.code === 'ITEM_NOT_VISIBLE' ||
            initialError.code === 'ITEM_NOT_IN_SESSION')
        ) {
          effectiveObservation = { ...observation, action: 'skipped' };
          pendingRef.current = effectiveObservation;
          setPending(effectiveObservation);
          writeWordStudyStorage(
            localStorage,
            storageKey,
            JSON.stringify(effectiveObservation)
          );
          ({ response, result } = await postObservation(effectiveObservation));
          toast.warning(tFeature('thisEntryChangedTheActionWasSafely'));
        }

        if (!response.ok || !result?.ok || !result.data) {
          const error = apiError(
            result,
            tFeature('couldNotSubmitTheStudyResult')
          );
          if (
            error.code === 'SEQUENCE_ALREADY_APPLIED' ||
            error.code === 'SEQUENCE_GAP'
          ) {
            const reconciled = await reconcileWithServer(effectiveObservation);
            if (reconciled) return;
          }
          throw error;
        }

        const nextSequence = effectiveObservation.sequence + 1;
        removeWordStudyStorage(localStorage, storageKey);
        pendingRef.current = null;
        setPending(null);
        setRevealed(false);
        setRecoveryMessage(null);
        if (effectiveObservation.action === 'unknown') {
          try {
            const mistakeResponse = await fetch(
              `/api/words/mistakes?word_entry_id=${encodeURIComponent(
                effectiveObservation.item_id
              )}`,
              { cache: 'no-store' }
            );
            const mistakePayload = (await mistakeResponse
              .json()
              .catch(() => null)) as ApiEnvelope<{
              mistake: WebWordStudyEntry['mistake'];
            }> | null;
            if (mistakeResponse.ok && mistakePayload?.ok) {
              setLastMistake(mistakePayload.data?.mistake || null);
            }
          } catch {
            // The observation is already durable; the relation can be loaded
            // again from the progress/mistake views if this best-effort read
            // is interrupted.
          }
        } else {
          setLastMistake(null);
        }
        setSession(current => ({
          ...current,
          status: current.status === 'abandoned' ? 'abandoned' : 'active',
          next_sequence: Math.max(current.next_sequence, nextSequence),
          last_activity_at: new Date().toISOString(),
          items: current.items.map(item =>
            item.item_id === effectiveObservation.item_id &&
            result.data?.progress
              ? { ...item, progress: result.data.progress }
              : item
          ),
          result: {
            ...current.result,
            known_count:
              current.result.known_count +
              (effectiveObservation.action === 'known' ? 1 : 0),
            unknown_count:
              current.result.unknown_count +
              (effectiveObservation.action === 'unknown' ? 1 : 0),
            skipped_count:
              current.result.skipped_count +
              (effectiveObservation.action === 'skipped' ? 1 : 0),
            looked_up_count:
              current.result.looked_up_count +
              (effectiveObservation.action === 'looked_up' ? 1 : 0),
          },
        }));
        await completeIfNeeded(nextSequence);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : tFeature('submissionFailedRetry');
        setRecoveryMessage(
          isRetryableFailure(error)
            ? tFeature('theResultIsSavedLocallyReconnectTo', {
                value0: String(message ?? ''),
              })
            : tFeature('theResultRemainsOnTheCurrentWord', {
                value0: String(message ?? ''),
              })
        );
      } finally {
        requestInFlightRef.current = false;
        setBusy(false);
      }
    },
    [completeIfNeeded, reconcileWithServer, tFeature]
  );

  const retryPending = useCallback(async () => {
    const observation = pendingRef.current;
    if (!observation || requestInFlightRef.current) return;
    await sendObservation(observation);
  }, [sendObservation]);

  useEffect(() => {
    if (initialRecoveryRef.current) return;
    initialRecoveryRef.current = true;
    const sessionId = initialSession.session_id;
    writeWordStudyStorage(
      localStorage,
      pendingWordSessionStorageKey(),
      sessionId
    );
    const storageKey = pendingWordObservationStorageKey(sessionId);
    const stored = parsePendingWebWordObservation(
      readWordStudyStorage(localStorage, storageKey),
      sessionId
    );
    if (!stored) {
      removeWordStudyStorage(localStorage, storageKey);
      if (
        initialSession.next_sequence >= initialSession.candidate_count &&
        initialSession.status !== 'completed'
      ) {
        void completeIfNeeded(initialSession.next_sequence);
      }
      return;
    }
    if (Date.parse(initialSession.expires_at) <= Date.now()) {
      pendingRef.current = stored;
      setPending(stored);
      setRecoveryMessage(tFeature('aPendingLocalResultRemainsButThe'));
      return;
    }

    const disposition = dispositionForPendingObservation(
      initialSession.next_sequence,
      stored
    );
    if (disposition === 'already_applied') {
      removeWordStudyStorage(localStorage, storageKey);
      void refreshSession();
      return;
    }
    if (disposition === 'invalid_gap') {
      pendingRef.current = stored;
      setPending(stored);
      setRecoveryMessage(
        tFeature('localAndCloudSequencesDifferSynchronizingAgain')
      );
      void reconcileWithServer(stored);
      return;
    }
    pendingRef.current = stored;
    setPending(stored);
    setRevealed(true);
    setRecoveryMessage(
      tFeature('restoringThePreviousUnconfirmedResultUsingThe')
    );
    void sendObservation(stored);
  }, [
    completeIfNeeded,
    initialSession,
    reconcileWithServer,
    refreshSession,
    sendObservation,
    tFeature,
  ]);

  useEffect(() => {
    const retry = () => {
      if (document.visibilityState === 'visible') void retryPending();
    };
    const online = () => void retryPending();
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [retryPending]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        busy ||
        !currentItem ||
        session.status !== 'active'
      ) {
        return;
      }
      if (event.code === 'Space' && !revealed) {
        event.preventDefault();
        setRevealed(true);
      } else if (revealed && event.key === '1') {
        event.preventDefault();
        void submitAction('unknown');
      } else if (revealed && event.key === '2') {
        event.preventDefault();
        void submitAction('known');
      } else if (revealed && event.key === '3') {
        event.preventDefault();
        void submitAction('skipped');
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  async function submitAction(action: WordObservationAction) {
    if (
      !currentItem ||
      busy ||
      pendingRef.current ||
      session.status !== 'active'
    ) {
      return;
    }
    const observation: PendingWebWordObservation = {
      request_id: createWebWordRequestId('webobservation'),
      session_id: session.session_id,
      sequence: session.next_sequence,
      item_id: currentItem.item_id,
      action,
      mode: session.mode,
      occurred_at: new Date().toISOString(),
    };
    await sendObservation(observation);
  }

  async function resumeSession() {
    setBusy(true);
    try {
      await updateStatus('active');
      setRecoveryMessage(null);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotRestoreTheSession')
      );
    } finally {
      setBusy(false);
    }
  }

  async function pauseAndLeave() {
    if (pendingRef.current) {
      setRecoveryMessage(tFeature('theCurrentResultIsNotConfirmedRetry'));
      return;
    }
    setBusy(true);
    try {
      await updateStatus('paused');
      router.push('/words');
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotPauseTheSession')
      );
    } finally {
      setBusy(false);
    }
  }

  async function abandonSession() {
    if (pendingRef.current) {
      setRecoveryMessage(tFeature('theCurrentResultIsNotConfirmedYou'));
      return;
    }
    if (!window.confirm(tFeature('endThisStudySessionSubmittedProgressWill')))
      return;
    setBusy(true);
    try {
      await updateStatus('abandoned');
      removeWordStudyStorage(localStorage, pendingWordSessionStorageKey());
      router.push('/words');
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotEndTheSession')
      );
    } finally {
      setBusy(false);
    }
  }

  if (completed) {
    return (
      <div className="section-container mx-auto max-w-3xl space-y-6">
        <Card>
          <CardContent className="flex flex-col items-center px-6 py-16 text-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 text-green-600">
              <Check className="h-8 w-8" />
            </div>
            <h1 className="text-2xl font-semibold">
              {tFeature('studySessionComplete')}
            </h1>
            <p className="mt-2 text-muted-foreground">
              {tFeature('confirmed')}
              {session.next_sequence} / {session.candidate_count}{' '}
              {tFeature('words')}
              {completionBusy ? tFeature('confirmingCompletion') : ''}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Badge variant="secondary">
                {tFeature('known')}
                {session.result.known_count}
              </Badge>
              <Badge variant="destructive">
                {tFeature('unknown')}
                {session.result.unknown_count}
              </Badge>
              <Badge variant="outline">
                {tFeature('skip')}
                {session.result.skipped_count}
              </Badge>
              {session.result.looked_up_count ? (
                <Badge variant="outline">
                  {tFeature('lookUp')}
                  {session.result.looked_up_count}
                </Badge>
              ) : null}
            </div>
            {recoveryMessage ? (
              <p className="mt-4 max-w-xl rounded-md bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                {recoveryMessage}
              </p>
            ) : null}
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {session.status !== 'completed' ? (
                <Button
                  variant="outline"
                  onClick={() => void completeIfNeeded(session.next_sequence)}
                  disabled={completionBusy}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {tFeature('retryCompletion')}
                </Button>
              ) : null}
              <Button asChild>
                <Link href="/words">{tFeature('backToVocabulary')}</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/words/study/new">
                  {tFeature('studyAnotherGroup')}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="section-container mx-auto max-w-3xl">
        <Card>
          <CardContent className="flex flex-col items-center px-6 py-16 text-center">
            <Clock3 className="mb-4 h-10 w-10 text-muted-foreground" />
            <h1 className="text-xl font-semibold">
              {tFeature('studySessionExpired')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {tFeature('submittedProgressIsPreservedStartANew')}
            </p>
            {recoveryMessage ? (
              <>
                <p className="mt-4 max-w-xl rounded-md bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                  {recoveryMessage}
                </p>
                {pending ? (
                  <Button
                    className="mt-3"
                    variant="ghost"
                    onClick={() => {
                      removeWordStudyStorage(
                        localStorage,
                        pendingWordObservationStorageKey(session.session_id)
                      );
                      pendingRef.current = null;
                      setPending(null);
                      setRecoveryMessage(null);
                    }}
                  >
                    {tFeature('clearExpiredPendingLocalResult')}
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button className="mt-7" asChild>
              <Link href="/words/study/new">{tFeature('startNewSession')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!currentItem) {
    return (
      <div className="section-container mx-auto max-w-3xl">
        <Card>
          <CardContent className="px-6 py-16 text-center">
            <p className="font-medium">
              {tFeature('thisSessionHasNoAvailableEntries')}
            </p>
            <Button className="mt-6" asChild>
              <Link href="/words">{tFeature('backToVocabulary')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const needsResume = session.status === 'paused';

  if (session.status === 'abandoned' && !pending) {
    return (
      <div className="section-container mx-auto max-w-3xl">
        <Card>
          <CardContent className="flex flex-col items-center px-6 py-16 text-center">
            <BookOpen className="mb-4 h-10 w-10 text-muted-foreground" />
            <h1 className="text-xl font-semibold">
              {tFeature('studySessionEnded')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {tFeature('confirmed')}
              {session.next_sequence} / {session.candidate_count}{' '}
              {tFeature('wordsSubmittedProgressIsPreserved')}
            </p>
            <div className="mt-7 flex gap-3">
              <Button asChild>
                <Link href="/words">{tFeature('backToVocabulary')}</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/words/study/new">
                  {tFeature('startNewSession')}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="section-container mx-auto max-w-5xl space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{heading}</h1>
            <Badge variant="secondary">{modeLabel(session.mode)}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {session.next_sequence + 1} / {session.candidate_count}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/words">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Word
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={pauseAndLeave}
            disabled={busy || needsResume}
          >
            <Pause className="mr-2 h-4 w-4" />
            {tFeature('pause')}
          </Button>
          <Button variant="ghost" onClick={abandonSession} disabled={busy}>
            {tFeature('end')}
          </Button>
        </div>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {recoveryMessage ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3 text-sm">
            <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>{recoveryMessage}</p>
          </div>
          {pending ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void retryPending()}
              disabled={busy}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {busy ? tFeature('submitting') : tFeature('retryTheSameRequest')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void refreshSession().catch(error =>
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : tFeature('synchronizationFailed')
                  )
                )
              }
            >
              {tFeature('synchronizeAgain')}
            </Button>
          )}
        </div>
      ) : null}

      {lastMistake ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <span>
            {tFeature('addedForQuestionReview')}
            {lastMistake.problem_title}
          </span>
          <Link
            className="text-primary hover:underline"
            href={`/problem-sets/${lastMistake.problem_set_id}/review?problemId=${lastMistake.problem_id}`}
          >
            {tFeature('viewQuestionNow')}
          </Link>
        </div>
      ) : null}

      {needsResume ? (
        <Card className="border-primary/30">
          <CardContent className="flex flex-col items-center px-6 py-12 text-center">
            <BookOpen className="mb-4 h-10 w-10 text-primary" />
            <h2 className="text-lg font-semibold">
              {tFeature('continueThisSession')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {tFeature('cloudProgressIsSavedThroughItem')}
              {session.next_sequence} {tFeature('words')}
            </p>
            <Button className="mt-6" onClick={resumeSession} disabled={busy}>
              {busy ? tFeature('restoring') : tFeature('continueLearning')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader className="border-b bg-muted/20 text-center">
            <div className="flex items-center justify-center gap-2">
              <Badge variant="outline">{currentItem.deck_title}</Badge>
              <Badge variant="secondary">
                {statusLabel(currentItem.progress.status)}
              </Badge>
              {currentItem.mistake ? (
                <Link
                  href={`/problem-sets/${currentItem.mistake.problem_set_id}/review?problemId=${currentItem.mistake.problem_id}`}
                >
                  <Badge variant="destructive">{tFeature('question')}</Badge>
                </Link>
              ) : null}
            </div>
            <CardTitle className="pt-5 text-4xl sm:text-5xl">
              {currentItem.word}
            </CardTitle>
            {currentItem.phonetic ? (
              <p className="text-base text-muted-foreground">
                {currentItem.phonetic}
              </p>
            ) : null}
          </CardHeader>
          <CardContent className="min-h-[22rem] px-5 py-8 sm:px-10">
            {!revealed ? (
              <div className="flex min-h-[17rem] flex-col items-center justify-center text-center">
                <p className="text-sm text-muted-foreground">
                  {tFeature('recallTheMeaningBeforeRevealingTheAnswer')}
                </p>
                <Button
                  size="lg"
                  className="mt-6"
                  onClick={() => setRevealed(true)}
                >
                  <Eye className="mr-2 h-5 w-5" />
                  {tFeature('revealMeaning')}
                </Button>
                <p className="mt-3 text-xs text-muted-foreground">
                  {tFeature('shortcutSpace')}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {tFeature('meaning')}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-xl leading-8">
                    {currentItem.meaning}
                  </p>
                </div>
                {currentItem.part_of_speech ? (
                  <Badge variant="outline">{currentItem.part_of_speech}</Badge>
                ) : null}
                {currentItem.example ? (
                  <>
                    <Separator />
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {tFeature('example')}
                      </p>
                      <p className="mt-2 text-base leading-7">
                        {currentItem.example}
                      </p>
                      {currentItem.example_translation ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {currentItem.example_translation}
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : null}

                {!currentItem.available ? (
                  <Button
                    className="w-full"
                    variant="outline"
                    size="lg"
                    onClick={() => void submitAction('skipped')}
                    disabled={busy || Boolean(pending)}
                  >
                    <SkipForward className="mr-2 h-5 w-5" />
                    {tFeature('skipRemovedEntry')}
                  </Button>
                ) : session.mode === 'dictionary' ? (
                  <div className="grid gap-3 pt-4 sm:grid-cols-2">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => void submitAction('skipped')}
                      disabled={busy || Boolean(pending)}
                    >
                      <SkipForward className="mr-2 h-5 w-5" />
                      {tFeature('skip')}
                    </Button>
                    <Button
                      size="lg"
                      onClick={() => void submitAction('looked_up')}
                      disabled={busy || Boolean(pending)}
                    >
                      <Check className="mr-2 h-5 w-5" />
                      {tFeature('next2')}
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-3 pt-4 sm:grid-cols-3">
                    <Button
                      variant="destructive"
                      size="lg"
                      onClick={() => void submitAction('unknown')}
                      disabled={busy || Boolean(pending)}
                    >
                      <X className="mr-2 h-5 w-5" />
                      {tFeature('unknown')}
                      <span className="ml-2 text-xs opacity-70">1</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => void submitAction('skipped')}
                      disabled={busy || Boolean(pending)}
                    >
                      <SkipForward className="mr-2 h-5 w-5" />
                      {tFeature('skip')}
                      <span className="ml-2 text-xs opacity-70">3</span>
                    </Button>
                    <Button
                      size="lg"
                      onClick={() => void submitAction('known')}
                      disabled={busy || Boolean(pending)}
                    >
                      <Check className="mr-2 h-5 w-5" />
                      {tFeature('known')}
                      <span className="ml-2 text-xs opacity-70">2</span>
                    </Button>
                  </div>
                )}
                {busy ? (
                  <p className="text-center text-sm text-muted-foreground">
                    {tFeature('confirmingTheResultTheNextWordOpens')}
                  </p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

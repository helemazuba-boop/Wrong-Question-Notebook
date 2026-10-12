'use client';
import { useTranslations as useFeatureTranslations } from 'next-intl';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import { isSafeInternalHref } from '@/lib/navigation-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  createWebNoteRequestId,
  dispositionForPendingNoteObservation,
  parsePendingWebNoteObservation,
  pendingNoteObservationStorageKey,
  pendingNoteSessionStorageKey,
  readNoteStudyStorage,
  removeNoteStudyStorage,
  noteStudyRetryDelayMs,
  writeNoteStudyStorage,
  type PendingWebNoteObservation,
} from '@/lib/note-study-client';
import type {
  WebNoteObservationAdvance,
  WebNoteStudyItem,
  WebNoteStudySessionView,
} from '@/lib/note-study-web';
import {
  ArrowLeft,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  CloudOff,
  ExternalLink,
  ListTodo,
  Pause,
  RotateCcw,
  SkipForward,
} from 'lucide-react';
import { toast } from 'sonner';

type Props = {
  notebookId: string;
  initialSession: WebNoteStudySessionView;
};

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; retryable?: boolean };
};

function apiError(
  result: ApiEnvelope<unknown> | null,
  fallback: string
): Error & { code?: string; retryable?: boolean } {
  return Object.assign(new Error(result?.error?.message || fallback), {
    code: result?.error?.code,
    retryable: Boolean(result?.error?.retryable),
  });
}

export default function NoteReadingSessionClient({
  notebookId,
  initialSession,
}: Props) {
  const tFeature = useFeatureTranslations('Notes');
  function readStateLabel(item: WebNoteStudyItem) {
    if (item.read_state.state === 'completed')
      return tFeature('previouslyRead');
    if (item.read_state.state === 'reading') return tFeature('reading');
    return tFeature('unread');
  }

  const router = useRouter();
  const from = useSearchParams().get('from');
  const backHref =
    from && isSafeInternalHref(from) ? from : `/notebooks/${notebookId}`;
  const [session, setSession] = useState(initialSession);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingWebNoteObservation | null>(
    null
  );
  const [message, setMessage] = useState<string | null>(null);
  const [todoBusy, setTodoBusy] = useState(false);
  const sessionRef = useRef(session);
  const pendingRef = useRef(pending);
  const requestInFlightRef = useRef(false);
  const recoveredRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryFailuresRef = useRef(0);
  const nextAutomaticRetryAtRef = useRef(0);
  const scheduleAutomaticRetryRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const currentItem = session.current_item;
  const complete =
    session.status === 'completed' ||
    session.next_sequence >= session.candidate_count;
  const expired = Date.parse(session.expires_at) <= Date.now();
  const progress = session.candidate_count
    ? Math.min(
        100,
        Math.round((session.next_sequence / session.candidate_count) * 100)
      )
    : 100;
  const heading = useMemo(
    () => session.notebook_titles.join('、') || tFeature('noteReading'),
    [session.notebook_titles]
  );

  const refreshSession = useCallback(async () => {
    const response = await fetch(
      `/api/notes/study/sessions/${sessionRef.current.session_id}`,
      {
        cache: 'no-store',
        headers: {
          'X-WQN-Request-Id': createWebNoteRequestId('note_sync'),
        },
      }
    );
    const result = (await response.json().catch(() => null)) as ApiEnvelope<{
      session: WebNoteStudySessionView;
    }> | null;
    if (!response.ok || !result?.ok || !result.data?.session) {
      throw apiError(result, tFeature('couldNotRestoreTheReadingSession'));
    }
    setSession(result.data.session);
    return result.data.session;
  }, []);

  const updateStatus = useCallback(
    async (status: 'active' | 'paused' | 'completed' | 'abandoned') => {
      const response = await fetch(
        `/api/notes/study/sessions/${sessionRef.current.session_id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: createWebNoteRequestId('note_status'),
            status,
          }),
        }
      );
      const result = (await response.json().catch(() => null)) as ApiEnvelope<{
        session: WebNoteStudySessionView;
      }> | null;
      if (!response.ok || !result?.ok || !result.data?.session) {
        throw apiError(result, tFeature('couldNotUpdateReadingStatus'));
      }
      setSession(current => ({
        ...current,
        status: result.data!.session.status,
        last_activity_at: result.data!.session.last_activity_at,
        expires_at: result.data!.session.expires_at,
      }));
    },
    []
  );

  const completeIfNeeded = useCallback(
    async (latest: WebNoteStudySessionView) => {
      if (
        latest.next_sequence < latest.candidate_count ||
        latest.status === 'completed'
      ) {
        return;
      }
      await updateStatus('completed');
      removeNoteStudyStorage(localStorage, pendingNoteSessionStorageKey());
    },
    [updateStatus]
  );

  const reconcile = useCallback(
    async (observation: PendingWebNoteObservation) => {
      const latest = await refreshSession();
      const disposition = dispositionForPendingNoteObservation(
        latest.next_sequence,
        observation
      );
      if (disposition === 'retry') return false;
      removeNoteStudyStorage(
        localStorage,
        pendingNoteObservationStorageKey(observation.session_id)
      );
      pendingRef.current = null;
      setPending(null);
      if (disposition === 'already_applied') {
        setMessage(tFeature('thisReadingActionWasConfirmedInThe'));
        await completeIfNeeded(latest);
      } else {
        setMessage(tFeature('localAndCloudPositionsDifferTheCloud'));
      }
      return true;
    },
    [completeIfNeeded, refreshSession]
  );

  const sendObservation = useCallback(
    async (observation: PendingWebNoteObservation) => {
      if (requestInFlightRef.current) return;
      requestInFlightRef.current = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      pendingRef.current = observation;
      setPending(observation);
      setBusy(true);
      setMessage(null);
      const key = pendingNoteObservationStorageKey(observation.session_id);
      if (
        !writeNoteStudyStorage(localStorage, key, JSON.stringify(observation))
      ) {
        setMessage(tFeature('theBrowserCannotSaveThePendingAction'));
      }
      try {
        const postObservation = async (value: PendingWebNoteObservation) => {
          const endpoint =
            value.action === 'skipped'
              ? '/api/notes/study/observations/skip'
              : '/api/notes/study/observations';
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
          });
          const result = (await response
            .json()
            .catch(
              () => null
            )) as ApiEnvelope<WebNoteObservationAdvance> | null;
          return { response, result };
        };

        let effectiveObservation = observation;
        let { response, result } = await postObservation(effectiveObservation);
        const initialError =
          !response.ok || !result?.ok || !result.data?.session
            ? apiError(result, tFeature('couldNotSubmitTheReadingAction'))
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
          writeNoteStudyStorage(
            localStorage,
            key,
            JSON.stringify(effectiveObservation)
          );
          ({ response, result } = await postObservation(effectiveObservation));
          toast.warning(tFeature('thisNoteChangedItWasSafelySkipped'));
        }
        if (!response.ok || !result?.ok || !result.data?.session) {
          const error = apiError(
            result,
            tFeature('couldNotSubmitTheReadingAction')
          );
          if (
            error.code === 'SEQUENCE_ALREADY_APPLIED' ||
            error.code === 'SEQUENCE_GAP'
          ) {
            if (await reconcile(effectiveObservation)) return;
          }
          throw error;
        }
        removeNoteStudyStorage(localStorage, key);
        pendingRef.current = null;
        setPending(null);
        retryFailuresRef.current = 0;
        nextAutomaticRetryAtRef.current = 0;
        const latest = result.data.session;
        sessionRef.current = latest;
        setSession(latest);
        if (latest.status === 'completed') {
          removeNoteStudyStorage(localStorage, pendingNoteSessionStorageKey());
        }
      } catch (error) {
        if (pendingRef.current) {
          retryFailuresRef.current += 1;
          const delay = noteStudyRetryDelayMs(retryFailuresRef.current);
          nextAutomaticRetryAtRef.current = Date.now() + delay;
          setMessage(
            tFeature('theActionRemainsSavedLocallyAfterFailed', {
              value0: String(
                error instanceof Error
                  ? error.message
                  : (tFeature('submissionFailed') ?? '')
              ),
              value1: String(retryFailuresRef.current ?? ''),
            })
          );
          scheduleAutomaticRetryRef.current?.();
        } else {
          setMessage(
            error instanceof Error
              ? error.message
              : tFeature('couldNotSynchronizeCloudStatus')
          );
        }
      } finally {
        requestInFlightRef.current = false;
        setBusy(false);
      }
    },
    [reconcile]
  );

  const submit = useCallback(
    (action: PendingWebNoteObservation['action']) => {
      const item = sessionRef.current.current_item;
      if (
        !item ||
        pendingRef.current ||
        requestInFlightRef.current ||
        sessionRef.current.status !== 'active'
      ) {
        return;
      }
      void sendObservation({
        request_id: createWebNoteRequestId('note_read'),
        session_id: sessionRef.current.session_id,
        sequence: sessionRef.current.next_sequence,
        item_id: item.item_id,
        action,
        mode: sessionRef.current.mode,
        occurred_at: new Date().toISOString(),
      });
    },
    [sendObservation]
  );

  useEffect(() => {
    if (recoveredRef.current) return;
    recoveredRef.current = true;
    writeNoteStudyStorage(
      localStorage,
      pendingNoteSessionStorageKey(),
      initialSession.session_id
    );
    const key = pendingNoteObservationStorageKey(initialSession.session_id);
    const stored = parsePendingWebNoteObservation(
      readNoteStudyStorage(localStorage, key),
      initialSession.session_id
    );
    if (!stored) {
      removeNoteStudyStorage(localStorage, key);
      if (
        initialSession.next_sequence >= initialSession.candidate_count &&
        initialSession.status !== 'completed'
      ) {
        void completeIfNeeded(initialSession);
      }
      return;
    }
    if (expired) {
      pendingRef.current = stored;
      setPending(stored);
      setMessage(tFeature('aPendingActionRemainsLocallyButThis'));
      return;
    }
    const disposition = dispositionForPendingNoteObservation(
      initialSession.next_sequence,
      stored
    );
    if (disposition === 'retry') {
      setMessage(tFeature('restoringThePreviousUnconfirmedReadingActionUsing'));
      void sendObservation(stored);
    } else {
      void reconcile(stored);
    }
  }, [completeIfNeeded, expired, initialSession, reconcile, sendObservation]);

  useEffect(() => {
    const retry = () => {
      if (
        document.visibilityState !== 'visible' ||
        !navigator.onLine ||
        !pendingRef.current
      ) {
        return;
      }
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      const delay = Math.max(0, nextAutomaticRetryAtRef.current - Date.now());
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (
          document.visibilityState === 'visible' &&
          navigator.onLine &&
          pendingRef.current &&
          !requestInFlightRef.current
        ) {
          void sendObservation(pendingRef.current);
        }
      }, delay);
    };
    scheduleAutomaticRetryRef.current = retry;
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      scheduleAutomaticRetryRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [sendObservation]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  async function pauseAndLeave() {
    if (pendingRef.current || busy) {
      toast.info(tFeature('waitForTheCurrentReadingActionTo'));
      return;
    }
    try {
      if (!complete && session.status === 'active')
        await updateStatus('paused');
      router.push(backHref);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tFeature('couldNotPause')
      );
    }
  }

  async function resume() {
    try {
      await updateStatus('active');
      await refreshSession();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotContinueReading')
      );
    }
  }

  async function createTodo() {
    if (!currentItem?.available || todoBusy) return;
    setTodoBusy(true);
    try {
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: tFeature('reviewNote', {
            value0: String(currentItem.title ?? ''),
          }),
          description: tFeature('fromNotebook', {
            value0: String(currentItem.notebook_title ?? ''),
          }),
          notebook_id: currentItem.notebook_id,
          note_id: currentItem.item_id,
          priority: 'normal',
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(result?.message || tFeature('couldNotCreateTheTodo'));
      toast.success(tFeature('addedToTodos'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotCreateTheTodo')
      );
    } finally {
      setTodoBusy(false);
    }
  }

  return (
    <div className="section-container">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={pauseAndLeave}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {tFeature('backToNotebook')}
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{heading}</Badge>
          <Badge variant="secondary">
            {session.next_sequence}/{session.candidate_count}
          </Badge>
        </div>
      </div>

      <div className="mb-5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>

      {message ? (
        <div className="mb-5 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{message}</span>
          {pending ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void sendObservation(pending)}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              {tFeature('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {complete ? (
        <Card className="mx-auto max-w-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              {tFeature('readingSessionComplete')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-3 gap-3 text-center">
              <Result
                label={tFeature('finishedReading')}
                value={session.result.completed_count}
              />
              <Result
                label={tFeature('readLater')}
                value={session.result.opened_count}
              />
              <Result
                label={tFeature('skipped')}
                value={session.result.skipped_count}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {tFeature('finishingAnItemRecordsReadingCompletionNot')}
            </p>
            <Button className="w-full" asChild>
              <Link href={backHref}>{tFeature('backToNotebookDetails')}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : expired || session.status === 'abandoned' ? (
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>
              {expired
                ? tFeature('readingSessionExpired')
                : tFeature('readingSessionEnded')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {tFeature('thisPageWillNotSubmitFurtherProgress')}
            </p>
            <Button className="w-full" asChild>
              <Link href={backHref}>{tFeature('backToNotebook')}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : session.status === 'paused' ? (
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>{tFeature('readingPaused')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {tFeature('theCurrentNoteHasNotAdvancedContinue')}
            </p>
            <Button className="w-full" onClick={resume}>
              <BookOpenCheck className="mr-2 h-4 w-4" />
              {tFeature('continueReading')}
            </Button>
          </CardContent>
        </Card>
      ) : currentItem ? (
        <Card className="mx-auto max-w-4xl">
          <CardHeader className="space-y-3 border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="mb-1 text-sm text-muted-foreground">
                  {currentItem.notebook_title} {tFeature('item')}
                  {currentItem.ordinal + 1} {tFeature('items')}
                </p>
                <CardTitle className="text-xl">{currentItem.title}</CardTitle>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{readStateLabel(currentItem)}</Badge>
                <Badge variant="outline">v{currentItem.revision}</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 p-6">
            <p className="whitespace-pre-wrap break-words text-base leading-8">
              {currentItem.content}
            </p>
            {currentItem.assets.length ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {currentItem.assets.map(asset => (
                  <a
                    key={asset.image_id}
                    href={`/api/files/${encodeURIComponent(asset.path)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="overflow-hidden rounded-md border bg-white"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/files/${encodeURIComponent(asset.path)}`}
                      alt={tFeature('noteImage')}
                      className="max-h-96 w-full object-contain"
                    />
                  </a>
                ))}
              </div>
            ) : null}
            <Separator />
            <div className="flex flex-wrap gap-2">
              {currentItem.linked_problem ? (
                <Button variant="outline" asChild>
                  <Link
                    href={
                      currentItem.linked_problem.problem_set_id
                        ? `/problem-sets/${currentItem.linked_problem.problem_set_id}/review?problemId=${currentItem.linked_problem.problem_id}`
                        : `/subjects/${currentItem.linked_problem.subject_id}/problems/${currentItem.linked_problem.problem_id}/review`
                    }
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {tFeature('viewLinkedQuestion')}
                  </Link>
                </Button>
              ) : null}
              {currentItem.available ? (
                <Button
                  variant="outline"
                  onClick={createTodo}
                  disabled={todoBusy}
                >
                  <ListTodo className="mr-2 h-4 w-4" />
                  {todoBusy ? tFeature('adding') : tFeature('addToTodos')}
                </Button>
              ) : null}
              <Button variant="outline" onClick={pauseAndLeave} disabled={busy}>
                <Pause className="mr-2 h-4 w-4" />
                {tFeature('pauseAndLeave')}
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                size="lg"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  submit(currentItem.available ? 'opened' : 'skipped')
                }
              >
                <SkipForward className="mr-2 h-4 w-4" />
                {currentItem.available
                  ? tFeature('readLaterNextNote')
                  : tFeature('skipRemovedNote')}
              </Button>
              {currentItem.available ? (
                <Button
                  size="lg"
                  disabled={busy}
                  onClick={() => submit('read_completed')}
                >
                  <BookOpenCheck className="mr-2 h-4 w-4" />
                  {busy ? tFeature('confirming') : tFeature('markAsRead')}
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              {tFeature('theNextNoteOpensOnlyAfterCloud')}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mx-auto max-w-xl">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {tFeature('theCurrentSessionPositionIsUnavailableReturn')}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Result({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted p-3">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

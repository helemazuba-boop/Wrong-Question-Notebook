'use client';

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

function modeLabel(mode: WebWordStudySessionView['mode']) {
  if (mode === 'sequential') return '顺序学习';
  if (mode === 'dictionary') return '词典浏览';
  return '智能复习';
}

function statusLabel(status: WebWordStudyEntry['progress']['status']) {
  if (status === 'learning') return '学习中';
  if (status === 'review') return '复习';
  if (status === 'mastered') return '已掌握';
  return '新词';
}

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
    () => session.deck_titles.join('、') || 'Word 学习',
    [session.deck_titles]
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
      throw apiError(result, '恢复学习会话失败');
    }
    setSession(result.data.session);
    return result.data.session;
  }, []);

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
        throw apiError(result, '更新会话状态失败');
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
        setRecoveryMessage(
          '学习内容已经全部提交，但完成状态尚未确认。页面会保留会话，稍后可重试。'
        );
      } finally {
        setCompletionBusy(false);
      }
    },
    [updateStatus]
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
        setRecoveryMessage(
          '当前词已经由另一页面或先前请求确认，已同步云端结果并继续。'
        );
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
        setRecoveryMessage(
          '本地待提交结果与云端当前题不一致，系统没有自动套用答案；已回到云端未完成词，请重新作答。'
        );
        return true;
      }
      return false;
    },
    [completeIfNeeded, refreshSession]
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
        setRecoveryMessage(
          '浏览器无法保存待提交结果。请保持页面打开，直到云端确认完成。'
        );
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
            ? apiError(result, '提交学习结果失败')
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
          toast.warning('词条已发生变化，本次记录已安全跳过。');
        }

        if (!response.ok || !result?.ok || !result.data) {
          const error = apiError(result, '提交学习结果失败');
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
          error instanceof Error ? error.message : '提交失败，请重试';
        setRecoveryMessage(
          isRetryableFailure(error)
            ? `${message}。结果已保存在本机，联网后可用同一请求继续提交。`
            : `${message}。结果仍保留在当前单词，请重试或重新同步。`
        );
      } finally {
        requestInFlightRef.current = false;
        setBusy(false);
      }
    },
    [completeIfNeeded, reconcileWithServer]
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
      setRecoveryMessage(
        '浏览器中仍有一个未确认结果，但云端会话已经过期，系统没有把它套用到新会话。'
      );
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
      setRecoveryMessage('检测到本地与云端序列不一致，正在重新同步。');
      void reconcileWithServer(stored);
      return;
    }
    pendingRef.current = stored;
    setPending(stored);
    setRevealed(true);
    setRecoveryMessage('发现上次未确认的学习结果，正在使用原请求恢复。');
    void sendObservation(stored);
  }, [
    completeIfNeeded,
    initialSession,
    reconcileWithServer,
    refreshSession,
    sendObservation,
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
      toast.error(error instanceof Error ? error.message : '恢复会话失败');
    } finally {
      setBusy(false);
    }
  }

  async function pauseAndLeave() {
    if (pendingRef.current) {
      setRecoveryMessage('当前学习结果尚未确认，请先重试后再暂停。');
      return;
    }
    setBusy(true);
    try {
      await updateStatus('paused');
      router.push('/words');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '暂停会话失败');
    } finally {
      setBusy(false);
    }
  }

  async function abandonSession() {
    if (pendingRef.current) {
      setRecoveryMessage('当前学习结果尚未确认，不能放弃会话。');
      return;
    }
    if (!window.confirm('确认结束本次学习？已提交的进度会保留。')) return;
    setBusy(true);
    try {
      await updateStatus('abandoned');
      removeWordStudyStorage(localStorage, pendingWordSessionStorageKey());
      router.push('/words');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '结束会话失败');
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
            <h1 className="text-2xl font-semibold">本次学习已完成</h1>
            <p className="mt-2 text-muted-foreground">
              已确认 {session.next_sequence} / {session.candidate_count} 个词。
              {completionBusy ? ' 正在确认完成状态…' : ''}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Badge variant="secondary">
                认识 {session.result.known_count}
              </Badge>
              <Badge variant="destructive">
                不认识 {session.result.unknown_count}
              </Badge>
              <Badge variant="outline">
                跳过 {session.result.skipped_count}
              </Badge>
              {session.result.looked_up_count ? (
                <Badge variant="outline">
                  查阅 {session.result.looked_up_count}
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
                  重试完成确认
                </Button>
              ) : null}
              <Button asChild>
                <Link href="/words">返回 Word</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/words/study/new">再学一组</Link>
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
            <h1 className="text-xl font-semibold">学习会话已过期</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              已提交的学习进度仍然保留，请创建一个新会话继续。
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
                    清除本机过期待提交结果
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button className="mt-7" asChild>
              <Link href="/words/study/new">开始新学习</Link>
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
            <p className="font-medium">当前会话没有可用词条</p>
            <Button className="mt-6" asChild>
              <Link href="/words">返回 Word</Link>
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
            <h1 className="text-xl font-semibold">本次学习已结束</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              已确认 {session.next_sequence} / {session.candidate_count} 个词，
              已提交的学习进度会保留。
            </p>
            <div className="mt-7 flex gap-3">
              <Button asChild>
                <Link href="/words">返回 Word</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/words/study/new">开始新学习</Link>
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
            暂停
          </Button>
          <Button variant="ghost" onClick={abandonSession} disabled={busy}>
            结束
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
              {busy ? '提交中…' : '重试同一请求'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void refreshSession().catch(error =>
                  toast.error(
                    error instanceof Error ? error.message : '同步失败'
                  )
                )
              }
            >
              重新同步
            </Button>
          )}
        </div>
      ) : null}

      {lastMistake ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <span>已加入错题：{lastMistake.problem_title}</span>
          <Link
            className="text-primary hover:underline"
            href={`/problem-sets/${lastMistake.problem_set_id}/review?problemId=${lastMistake.problem_id}`}
          >
            立即查看错题
          </Link>
        </div>
      ) : null}

      {needsResume ? (
        <Card className="border-primary/30">
          <CardContent className="flex flex-col items-center px-6 py-12 text-center">
            <BookOpen className="mb-4 h-10 w-10 text-primary" />
            <h2 className="text-lg font-semibold">继续这次学习</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              云端已经保存到第 {session.next_sequence} 个词。
            </p>
            <Button className="mt-6" onClick={resumeSession} disabled={busy}>
              {busy ? '恢复中…' : '继续学习'}
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
                  <Badge variant="destructive">错题</Badge>
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
                  先在心里回忆释义，再揭示答案。
                </p>
                <Button
                  size="lg"
                  className="mt-6"
                  onClick={() => setRevealed(true)}
                >
                  <Eye className="mr-2 h-5 w-5" />
                  揭示释义
                </Button>
                <p className="mt-3 text-xs text-muted-foreground">
                  快捷键：空格
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    释义
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
                        例句
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
                    跳过已移除词条
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
                      跳过
                    </Button>
                    <Button
                      size="lg"
                      onClick={() => void submitAction('looked_up')}
                      disabled={busy || Boolean(pending)}
                    >
                      <Check className="mr-2 h-5 w-5" />
                      下一个
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
                      不认识
                      <span className="ml-2 text-xs opacity-70">1</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => void submitAction('skipped')}
                      disabled={busy || Boolean(pending)}
                    >
                      <SkipForward className="mr-2 h-5 w-5" />
                      跳过
                      <span className="ml-2 text-xs opacity-70">3</span>
                    </Button>
                    <Button
                      size="lg"
                      onClick={() => void submitAction('known')}
                      disabled={busy || Boolean(pending)}
                    >
                      <Check className="mr-2 h-5 w-5" />
                      认识
                      <span className="ml-2 text-xs opacity-70">2</span>
                    </Button>
                  </div>
                )}
                {busy ? (
                  <p className="text-center text-sm text-muted-foreground">
                    正在确认学习结果，确认前不会进入下一词…
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

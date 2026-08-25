'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
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

function readStateLabel(item: WebNoteStudyItem) {
  if (item.read_state.state === 'completed') return '读过';
  if (item.read_state.state === 'reading') return '阅读中';
  return '未读';
}

export default function NoteReadingSessionClient({
  notebookId,
  initialSession,
}: Props) {
  const router = useRouter();
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
    () => session.notebook_titles.join('、') || 'Note 阅读',
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
      throw apiError(result, '恢复阅读会话失败');
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
        throw apiError(result, '更新阅读状态失败');
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
        setMessage('这次阅读已在云端确认，已恢复到正确位置。');
        await completeIfNeeded(latest);
      } else {
        setMessage('本地记录与云端位置不一致，未自动套用，已回到云端进度。');
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
        setMessage('浏览器无法保存待提交状态，请保持页面打开直到云端确认。');
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
            ? apiError(result, '提交阅读记录失败')
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
          toast.warning('笔记已发生变化，本次已安全跳过。');
        }
        if (!response.ok || !result?.ok || !result.data?.session) {
          const error = apiError(result, '提交阅读记录失败');
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
            `${error instanceof Error ? error.message : '提交失败'}。记录仍保留在本机；连续失败 ${retryFailuresRef.current} 次，将在网络可用时退避重试。`
          );
          scheduleAutomaticRetryRef.current?.();
        } else {
          setMessage(
            error instanceof Error ? error.message : '云端状态同步失败'
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
      setMessage(
        '本机仍有未确认记录，但这个会话已经过期；系统不会把它套用到新会话。'
      );
      return;
    }
    const disposition = dispositionForPendingNoteObservation(
      initialSession.next_sequence,
      stored
    );
    if (disposition === 'retry') {
      setMessage('发现上次未确认的阅读操作，正在使用同一请求恢复。');
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
      toast.info('请等待当前阅读记录确认');
      return;
    }
    try {
      if (!complete && session.status === 'active')
        await updateStatus('paused');
      router.push(`/notebooks/${notebookId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '暂停失败');
    }
  }

  async function resume() {
    try {
      await updateStatus('active');
      await refreshSession();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '继续阅读失败');
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
          title: `回顾笔记：${currentItem.title}`,
          description: `来自笔记本「${currentItem.notebook_title}」`,
          notebook_id: currentItem.notebook_id,
          note_id: currentItem.item_id,
          priority: 'normal',
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || '创建 Todo 失败');
      toast.success('已加入 Todo');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建 Todo 失败');
    } finally {
      setTodoBusy(false);
    }
  }

  return (
    <div className="section-container">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={pauseAndLeave}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回笔记本
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
              重试
            </Button>
          ) : null}
        </div>
      ) : null}

      {complete ? (
        <Card className="mx-auto max-w-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              本轮阅读完成
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-3 gap-3 text-center">
              <Result label="读完" value={session.result.completed_count} />
              <Result label="稍后再看" value={session.result.opened_count} />
              <Result label="已跳过" value={session.result.skipped_count} />
            </div>
            <p className="text-sm text-muted-foreground">
              “读完”只记录阅读完成，不代表掌握；你可以从笔记本再次开始阅读。
            </p>
            <Button className="w-full" asChild>
              <Link href={`/notebooks/${notebookId}`}>返回笔记本详情</Link>
            </Button>
          </CardContent>
        </Card>
      ) : expired || session.status === 'abandoned' ? (
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>
              {expired ? '阅读会话已过期' : '阅读会话已结束'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              当前页面不会继续提交旧进度。返回笔记本即可建立新的阅读会话。
            </p>
            <Button className="w-full" asChild>
              <Link href={`/notebooks/${notebookId}`}>返回笔记本</Link>
            </Button>
          </CardContent>
        </Card>
      ) : session.status === 'paused' ? (
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>阅读已暂停</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              当前笔记没有被推进，继续后仍从这里开始。
            </p>
            <Button className="w-full" onClick={resume}>
              <BookOpenCheck className="mr-2 h-4 w-4" />
              继续阅读
            </Button>
          </CardContent>
        </Card>
      ) : currentItem ? (
        <Card className="mx-auto max-w-4xl">
          <CardHeader className="space-y-3 border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="mb-1 text-sm text-muted-foreground">
                  {currentItem.notebook_title} · 第 {currentItem.ordinal + 1} 篇
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
                      alt="笔记图片"
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
                    查看关联错题
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
                  {todoBusy ? '添加中...' : '加入 Todo'}
                </Button>
              ) : null}
              <Button variant="outline" onClick={pauseAndLeave} disabled={busy}>
                <Pause className="mr-2 h-4 w-4" />
                暂停并离开
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
                {currentItem.available ? '稍后再看 / 下一篇' : '跳过已移除笔记'}
              </Button>
              {currentItem.available ? (
                <Button
                  size="lg"
                  disabled={busy}
                  onClick={() => submit('read_completed')}
                >
                  <BookOpenCheck className="mr-2 h-4 w-4" />
                  {busy ? '正在确认...' : '标记读完'}
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              只有云端确认后才会进入下一篇；直接关闭会保留当前位置。
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mx-auto max-w-xl">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            会话当前位置不可用，请返回笔记本重新开始。
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

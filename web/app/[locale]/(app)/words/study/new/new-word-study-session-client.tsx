'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { WordDeckItem } from '@/lib/words';
import {
  createWebWordRequestId,
  readWordStudyStorage,
  removeWordStudyStorage,
  writeWordStudyStorage,
} from '@/lib/word-study-client';
import type { WordStudyMode } from '@/lib/word-study-v1';
import { ArrowLeft, BookOpenCheck, Play } from 'lucide-react';
import { toast } from 'sonner';

type Props = { decks: WordDeckItem[] };

type SessionResponse = {
  ok: boolean;
  data?: { session_id?: string; items?: unknown[] };
  error?: { message?: string; code?: string };
};

const PENDING_SESSION_CREATE_KEY = 'wqn:word-study:pending-create';

export default function NewWordStudySessionClient({ decks }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialDeck = searchParams.get('deck');
  const selectableDecks = useMemo(
    () => decks.filter(deck => deck.is_active && deck.word_count > 0),
    [decks]
  );
  const [selectedDeckIds, setSelectedDeckIds] = useState<string[]>(() =>
    initialDeck && selectableDecks.some(deck => deck.id === initialDeck)
      ? [initialDeck]
      : selectableDecks[0]
        ? [selectableDecks[0].id]
        : []
  );
  const [mode, setMode] = useState<WordStudyMode>('random');
  const [count, setCount] = useState('20');
  const [includeMastered, setIncludeMastered] = useState(false);
  const [busy, setBusy] = useState(false);
  const retryRef = useRef<{ fingerprint: string; requestId: string } | null>(
    null
  );

  function toggleDeck(deckId: string, checked: boolean) {
    setSelectedDeckIds(current =>
      checked
        ? [...new Set([...current, deckId])].slice(0, 32)
        : current.filter(id => id !== deckId)
    );
    retryRef.current = null;
  }

  async function startSession(event: FormEvent) {
    event.preventDefault();
    if (selectedDeckIds.length === 0) {
      toast.error('至少选择一个有词条的词库');
      return;
    }
    const payloadBase = {
      mode,
      deck_ids: selectedDeckIds,
      include_mastered: mode === 'random' ? includeMastered : true,
      optional_count: Number(count),
    };
    const fingerprint = JSON.stringify(payloadBase);
    if (retryRef.current?.fingerprint !== fingerprint) {
      let stored: { fingerprint?: string; requestId?: string } | null = null;
      try {
        stored = JSON.parse(
          readWordStudyStorage(sessionStorage, PENDING_SESSION_CREATE_KEY) ||
            'null'
        );
      } catch {
        removeWordStudyStorage(sessionStorage, PENDING_SESSION_CREATE_KEY);
      }
      retryRef.current =
        stored?.fingerprint === fingerprint &&
        typeof stored.requestId === 'string' &&
        stored.requestId.length >= 16
          ? { fingerprint, requestId: stored.requestId }
          : {
              fingerprint,
              requestId: createWebWordRequestId('websession'),
            };
    }
    writeWordStudyStorage(
      sessionStorage,
      PENDING_SESSION_CREATE_KEY,
      JSON.stringify(retryRef.current)
    );

    setBusy(true);
    try {
      const response = await fetch('/api/words/study/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: retryRef.current.requestId,
          ...payloadBase,
        }),
      });
      const result = (await response
        .json()
        .catch(() => null)) as SessionResponse | null;
      if (!response.ok || !result?.ok || !result.data?.session_id) {
        throw new Error(
          result?.error?.message ||
            (result?.error?.code === 'WORD_SCOPE_NOT_VISIBLE'
              ? '词库已不可用，请刷新后重试'
              : '创建学习会话失败')
        );
      }
      removeWordStudyStorage(sessionStorage, PENDING_SESSION_CREATE_KEY);
      router.replace(`/words/study/${result.data.session_id}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '创建学习会话失败，请重试'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section-container space-y-6">
      <PageHeader
        title="开始 Word 学习"
        description="创建的是云端学习会话。刷新、离开或切换设备后，进度仍可继续。"
        actions={
          <Button variant="outline" asChild>
            <Link href="/words">
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回 Word
            </Link>
          </Button>
        }
      />

      <form onSubmit={startSession} className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>选择词库</CardTitle>
          </CardHeader>
          <CardContent>
            {selectableDecks.length === 0 ? (
              <div className="rounded-md border border-dashed p-10 text-center">
                <BookOpenCheck className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
                <p className="font-medium">还没有可学习的词条</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  先向词库添加或导入单词。
                </p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {selectableDecks.map(deck => {
                  const selected = selectedDeckIds.includes(deck.id);
                  return (
                    <label
                      key={deck.id}
                      className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors ${
                        selected ? 'border-primary bg-primary/5' : ''
                      }`}
                    >
                      <Checkbox
                        checked={selected}
                        onCheckedChange={checked =>
                          toggleDeck(deck.id, checked === true)
                        }
                        aria-label={`选择${deck.title}`}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 font-medium">
                          <span className="truncate">{deck.title}</span>
                          {deck.is_system ? (
                            <Badge variant="secondary">系统</Badge>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-sm text-muted-foreground">
                          {deck.word_count} 词 · {deck.subject_name || '无科目'}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>学习方式</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <RadioGroup
              value={mode}
              onValueChange={value => {
                setMode(value as WordStudyMode);
                retryRef.current = null;
              }}
              className="space-y-3"
            >
              {[
                ['random', '智能复习', '到期与学习中词优先，再穿插新词'],
                ['sequential', '顺序学习', '按照词库原有顺序学习'],
                ['dictionary', '词典浏览', '按字母顺序完整浏览'],
              ].map(([value, title, description]) => (
                <div key={value} className="flex items-start gap-3">
                  <RadioGroupItem value={value} id={`mode-${value}`} />
                  <Label htmlFor={`mode-${value}`} className="cursor-pointer">
                    <span className="block font-medium">{title}</span>
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {description}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>

            <div className="space-y-2">
              <Label htmlFor="study-count">本次数量</Label>
              <Select
                value={count}
                onValueChange={value => {
                  setCount(value);
                  retryRef.current = null;
                }}
              >
                <SelectTrigger id="study-count">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 30, 50, 100].map(value => (
                    <SelectItem key={value} value={String(value)}>
                      {value} 词
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {mode === 'random' ? (
              <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                <div>
                  <Label htmlFor="include-mastered">包含已掌握</Label>
                  <p className="text-xs text-muted-foreground">
                    默认跳过已经掌握的词
                  </p>
                </div>
                <Switch
                  id="include-mastered"
                  checked={includeMastered}
                  onCheckedChange={value => {
                    setIncludeMastered(value);
                    retryRef.current = null;
                  }}
                />
              </div>
            ) : null}

            <Button
              type="submit"
              className="w-full"
              disabled={busy || selectedDeckIds.length === 0}
            >
              <Play className="mr-2 h-4 w-4" />
              {busy ? '创建会话中…' : '开始学习'}
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}

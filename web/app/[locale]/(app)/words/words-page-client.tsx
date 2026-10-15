'use client';
import {
  useTranslations as useFeatureTranslations,
  useLocale as useFeatureLocale,
} from 'next-intl';

import { useMemo, useState, type FormEvent } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { WordDeckItem } from '@/lib/words';
import type {
  WebWordStudySessionSummary,
  WordDeckStudySummary,
} from '@/lib/word-study-web';
import {
  BookA,
  Clock3,
  FolderOpen,
  MoreHorizontal,
  Play,
  Plus,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';

type Props = {
  initialDecks: WordDeckItem[];
  initialSummaries: Record<string, WordDeckStudySummary>;
  initialSessions: WebWordStudySessionSummary[];
};

export default function WordsPageClient({
  initialDecks,
  initialSummaries,
  initialSessions,
}: Props) {
  const tFeature = useFeatureTranslations('Words');
  const featureLocale = useFeatureLocale();
  function formatActivity(value: string) {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return tFeature('noHistoryYet');
    return new Intl.DateTimeFormat(featureLocale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }
  function modeLabel(mode: WebWordStudySessionSummary['mode']) {
    if (mode === 'sequential') return tFeature('sequentialStudy');
    if (mode === 'dictionary') return tFeature('dictionaryBrowsing');
    return tFeature('smartReview');
  }

  const router = useRouter();
  const [decks, setDecks] = useState(initialDecks);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [editingDeck, setEditingDeck] = useState<WordDeckItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const filteredDecks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return decks;
    return decks.filter(
      deck =>
        deck.title.toLocaleLowerCase('zh-CN').includes(normalized) ||
        (deck.description || '').toLocaleLowerCase('zh-CN').includes(normalized)
    );
  }, [decks, query]);

  const totals = useMemo(
    () =>
      Object.values(initialSummaries).reduce(
        (result, summary) => ({
          total: result.total + summary.total,
          due: result.due + summary.due_count,
          learning: result.learning + summary.learning_count,
          mastered: result.mastered + summary.mastered_count,
        }),
        { total: 0, due: 0, learning: 0, mastered: 0 }
      ),
    [initialSummaries]
  );

  async function createDeck(event: FormEvent) {
    event.preventDefault();
    if (!createTitle.trim()) return;
    setCreateBusy(true);
    try {
      const response = await fetch('/api/words/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: createTitle.trim(),
          description: createDescription.trim() || null,
          subject_id: null,
          source: 'user',
          language: 'en',
          target_language: 'zh-CN',
          lexicon_type: 'english_word',
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || tFeature('couldNotCreateTheDeck'));
      }
      const deck = payload?.data?.deck as WordDeckItem | undefined;
      toast.success(tFeature('deckCreated'));
      setCreateOpen(false);
      setCreateTitle('');
      setCreateDescription('');
      if (deck) {
        setDecks(current => [deck, ...current]);
        router.push(`/words/decks/${deck.id}`);
      } else {
        router.refresh();
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotCreateTheDeck')
      );
    } finally {
      setCreateBusy(false);
    }
  }

  function openEdit(deck: WordDeckItem) {
    setEditingDeck(deck);
    setEditTitle(deck.title);
    setEditDescription(deck.description || '');
  }

  async function saveDeck(event: FormEvent) {
    event.preventDefault();
    if (!editingDeck || !editTitle.trim()) return;
    setEditBusy(true);
    try {
      const response = await fetch(`/api/words/decks/${editingDeck.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim() || null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || tFeature('couldNotSaveTheDeck'));
      }
      const updated = payload?.data?.deck as WordDeckItem;
      setDecks(current =>
        current.map(deck => (deck.id === updated.id ? updated : deck))
      );
      setEditingDeck(null);
      toast.success(tFeature('deckDetailsSaved'));
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tFeature('couldNotSaveTheDeck')
      );
    } finally {
      setEditBusy(false);
    }
  }

  async function archiveDeck() {
    if (!editingDeck) return;
    if (
      !window.confirm(
        tFeature('archive2', { value0: String(editingDeck.title ?? '') })
      )
    )
      return;
    setEditBusy(true);
    try {
      const response = await fetch(`/api/words/decks/${editingDeck.id}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || tFeature('couldNotArchiveTheDeck'));
      }
      setDecks(current => current.filter(deck => deck.id !== editingDeck.id));
      setEditingDeck(null);
      toast.success(tFeature('deckArchived'));
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotArchiveTheDeck')
      );
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <div className="section-container space-y-6">
      <PageHeader
        title="Word"
        description={tFeature('manageDecksAndContinueTheSameLearning')}
        actions={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {tFeature('newDeck')}
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/words/progress">{tFeature('learningProgress')}</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/words/mistakes">{tFeature('mistakes')}</Link>
            </Button>
            <Button asChild>
              <Link href="/words/study/new">
                <Play className="mr-2 h-4 w-4" />
                {tFeature('startLearning')}
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [tFeature('allEntries'), totals.total],
          [tFeature('dueToday'), totals.due],
          [tFeature('learning'), totals.learning],
          [tFeature('mastered'), totals.mastered],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">
              {value}
            </CardContent>
          </Card>
        ))}
      </div>

      {initialSessions.length > 0 ? (
        <Card className="border-amber-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock3 className="h-4 w-4" />
              {tFeature('continueUnfinishedStudy')}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-2">
            {initialSessions.map(session => (
              <div
                key={session.session_id}
                className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">
                    {session.deck_titles.join('、') ||
                      tFeature('vocabularyStudy')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {modeLabel(session.mode)} · {session.next_sequence}/
                    {session.candidate_count} ·{' '}
                    {formatActivity(session.last_activity_at)}
                  </p>
                </div>
                <Button asChild size="sm">
                  <Link href={`/words/study/${session.session_id}`}>
                    {tFeature('continueLearning')}
                  </Link>
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={tFeature('searchDecks')}
            className="pl-9"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {filteredDecks.length} {tFeature('availableDecks')}
        </p>
      </div>

      {filteredDecks.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-16 text-center">
          <BookA className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
          <p className="font-medium">{tFeature('noMatchingDecks')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {tFeature('youCanStartWithADeckThat')}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredDecks.map(deck => {
            const summary = initialSummaries[deck.id];
            return (
              <Card key={deck.id} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-lg">
                        {deck.title}
                      </CardTitle>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {deck.description || tFeature('noDescription')}
                      </p>
                    </div>
                    <Badge variant={deck.is_system ? 'default' : 'secondary'}>
                      {deck.is_system ? tFeature('system') : tFeature('custom')}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-lg font-semibold">
                      {summary?.total ?? deck.word_count}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {tFeature('entries3')}
                    </p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold">
                      {summary?.due_count ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {tFeature('due2')}
                    </p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold">
                      {summary?.mastered_count ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {tFeature('mastery')}
                    </p>
                  </div>
                </CardContent>
                <CardFooter className="mt-auto flex gap-2">
                  {deck.word_count > 0 ? (
                    <Button asChild className="flex-1">
                      <Link href={`/words/study/new?deck=${deck.id}`}>
                        <Play className="mr-2 h-4 w-4" />
                        {tFeature('study')}
                      </Link>
                    </Button>
                  ) : (
                    <Button className="flex-1" disabled>
                      {tFeature('noEntriesYet')}
                    </Button>
                  )}
                  <Button variant="outline" size="icon" asChild>
                    <Link
                      href={`/words/decks/${deck.id}`}
                      aria-label={tFeature('manage', {
                        value0: String(deck.title ?? ''),
                      })}
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Link>
                  </Button>
                  {!deck.is_system ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(deck)}
                      aria-label={tFeature('edit2', {
                        value0: String(deck.title ?? ''),
                      })}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  ) : null}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form onSubmit={createDeck}>
            <DialogHeader>
              <DialogTitle>{tFeature('newDeck')}</DialogTitle>
              <DialogDescription>
                {tFeature('youCanImportAndStudyWithoutAssigning')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-5">
              <div className="space-y-2">
                <Label htmlFor="word-deck-title">{tFeature('name')}</Label>
                <Input
                  id="word-deck-title"
                  value={createTitle}
                  onChange={event => setCreateTitle(event.target.value)}
                  placeholder={tFeature('highSchoolVocabulary')}
                  maxLength={80}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="word-deck-description">
                  {tFeature('description2')}
                </Label>
                <Textarea
                  id="word-deck-description"
                  value={createDescription}
                  onChange={event => setCreateDescription(event.target.value)}
                  maxLength={500}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                {tFeature('cancel')}
              </Button>
              <Button type="submit" disabled={createBusy}>
                {createBusy ? tFeature('creating2') : tFeature('createDeck')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editingDeck)}
        onOpenChange={open => !open && setEditingDeck(null)}
      >
        <DialogContent>
          <form onSubmit={saveDeck}>
            <DialogHeader>
              <DialogTitle>{tFeature('editDeck')}</DialogTitle>
              <DialogDescription>
                {tFeature('changingTheNameOrDescriptionPreservesLearning')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-5">
              <div className="space-y-2">
                <Label htmlFor="edit-word-deck-title">{tFeature('name')}</Label>
                <Input
                  id="edit-word-deck-title"
                  value={editTitle}
                  onChange={event => setEditTitle(event.target.value)}
                  maxLength={80}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-word-deck-description">
                  {tFeature('description2')}
                </Label>
                <Textarea
                  id="edit-word-deck-description"
                  value={editDescription}
                  onChange={event => setEditDescription(event.target.value)}
                  maxLength={500}
                />
              </div>
            </div>
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="destructive"
                onClick={archiveDeck}
                disabled={editBusy}
              >
                {tFeature('archiveDeck')}
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingDeck(null)}
                >
                  {tFeature('cancel')}
                </Button>
                <Button type="submit" disabled={editBusy}>
                  {editBusy ? tFeature('saving2') : tFeature('save')}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

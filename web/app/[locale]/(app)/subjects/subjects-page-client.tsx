'use client';
import {
  useTranslations as useFeatureTranslations,
  useLocale as useFeatureLocale,
} from 'next-intl';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { NotebookShelfItem } from '@/lib/notebooks';
import { createWebNoteRequestId } from '@/lib/note-study-client';
import {
  findDefaultSubjectId,
  sortSubjectsByPresetOrder,
} from '@/lib/subject-presets';
import type { SubjectWithMetadata } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  BookA,
  BookOpen,
  CheckCircle2,
  FileText,
  NotebookPen,
  PlayCircle,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';

type CreateKind = 'problem_set' | 'notebook' | 'word_deck';
type ShelfContentType = CreateKind;
type TypeFilter = 'all' | ShelfContentType;

interface SubjectsPageClientProps {
  initialSubjects: SubjectWithMetadata[];
  initialShelfItems: NotebookShelfItem[];
}

export default function SubjectsPageClient({
  initialSubjects,
  initialShelfItems,
}: SubjectsPageClientProps) {
  const tFeature = useFeatureTranslations('Notebooks.shelf');
  function createdMessage(kind: CreateKind) {
    if (kind === 'notebook') return tFeature('notebookCreated');
    if (kind === 'word_deck') return tFeature('deckCreated');
    return tFeature('questionNotebookCreated');
  }
  function createSubmitLabel(kind: CreateKind) {
    if (kind === 'notebook') return tFeature('createNotebook');
    if (kind === 'word_deck') return tFeature('createDeck');
    return tFeature('createQuestionNotebook');
  }
  function defaultTitlePlaceholder(kind: CreateKind) {
    if (kind === 'notebook') return tFeature('classNotes');
    if (kind === 'word_deck') return tFeature('highSchoolVocabulary');
    return tFeature('functionQuestions');
  }

  const router = useRouter();
  const [subjects] = useState(() => sortSubjectsByPresetOrder(initialSubjects));
  const [items, setItems] = useState(initialShelfItems);
  const [query, setQuery] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind>('notebook');
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createSubjectId, setCreateSubjectId] = useState(() =>
    findDefaultSubjectId(initialSubjects)
  );
  const [createBusy, setCreateBusy] = useState(false);
  const [accessBusyId, setAccessBusyId] = useState<string | null>(null);
  const [readingBusyId, setReadingBusyId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter(item => {
      if (typeFilter !== 'all' && item.type !== typeFilter) {
        return false;
      }
      if (subjectFilter !== 'all' && item.subject_id !== subjectFilter) {
        return false;
      }
      if (!normalizedQuery) return true;
      return (
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.subject_name.toLowerCase().includes(normalizedQuery) ||
        (item.description || '').toLowerCase().includes(normalizedQuery)
      );
    });
  }, [items, query, subjectFilter, typeFilter]);

  const hasFilters =
    query.trim().length > 0 || subjectFilter !== 'all' || typeFilter !== 'all';

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        target?.getAttribute('contenteditable') === 'true'
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  async function refreshShelf() {
    const response = await fetch('/api/notebook-shelf', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(tFeature('couldNotRefreshTheShelf'));
    }
    const payload = await response.json();
    setItems(payload.data?.items || []);
    router.refresh();
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!createTitle.trim()) {
      toast.error(tFeature('enterAName'));
      return;
    }
    if (
      createKind !== 'word_deck' &&
      (!createSubjectId || createSubjectId === '_none')
    ) {
      toast.error(tFeature('chooseACategory'));
      return;
    }

    setCreateBusy(true);
    try {
      const endpoint =
        createKind === 'notebook'
          ? '/api/notebooks'
          : createKind === 'word_deck'
            ? '/api/words/decks'
            : '/api/problem-sets';
      const body =
        createKind === 'notebook'
          ? {
              subject_id: createSubjectId,
              title: createTitle.trim(),
              description: createDescription.trim() || null,
            }
          : createKind === 'word_deck'
            ? {
                subject_id:
                  createSubjectId && createSubjectId !== '_none'
                    ? createSubjectId
                    : null,
                title: createTitle.trim(),
                description: createDescription.trim() || null,
                source: 'user',
                language: 'en',
                target_language: 'zh-CN',
                lexicon_type: 'english_word',
              }
            : {
                subject_id: createSubjectId,
                name: createTitle.trim(),
                description: createDescription.trim() || '',
                sharing_level: 'private',
                problem_ids: [],
                allow_copying: false,
              };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || tFeature('couldNotCreate'));
      }

      setCreateOpen(false);
      setCreateTitle('');
      setCreateDescription('');
      toast.success(createdMessage(createKind));
      await refreshShelf();

      const createdId =
        payload?.data?.notebook?.id ||
        payload?.data?.deck?.id ||
        payload?.data?.id;
      if (createdId) {
        router.push(
          createKind === 'notebook'
            ? `/notebooks/${createdId}`
            : createKind === 'word_deck'
              ? `/words/decks/${createdId}`
              : `/problem-sets/${createdId}?from=${encodeURIComponent('/subjects')}`
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tFeature('couldNotCreate')
      );
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleAiAccessChange(
    item: NotebookShelfItem,
    enabled: boolean
  ) {
    if (item.type !== 'notebook') return;
    setAccessBusyId(item.id);
    try {
      const response = await fetch(`/api/notebooks/${item.id}/ai-access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          can_read: enabled,
          can_create: enabled,
          can_update: false,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          payload?.message || tFeature('couldNotUpdateAiPermissions')
        );
      }
      setItems(prev =>
        prev.map(prevItem =>
          prevItem.id === item.id
            ? {
                ...prevItem,
                ai_access: {
                  can_read: enabled,
                  can_create: enabled,
                  can_update: false,
                },
              }
            : prevItem
        )
      );
      toast.success(
        enabled
          ? tFeature('aiCanNowCreateNotes2')
          : tFeature('aiPermissionRemoved')
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotUpdateAiPermissions')
      );
    } finally {
      setAccessBusyId(null);
    }
  }

  function openItem(item: NotebookShelfItem) {
    router.push(
      item.type === 'problem_set'
        ? `/problem-sets/${item.id}?from=${encodeURIComponent('/subjects')}`
        : item.type === 'word_deck'
          ? `/words/decks/${item.id}`
          : `/notebooks/${item.id}`
    );
  }

  async function startOrContinueReading(item: NotebookShelfItem) {
    if (item.type !== 'notebook') return;
    const existing = item.read_summary?.resumable_session_id;
    if (existing) {
      router.push(`/notebooks/${item.id}/read/${existing}`);
      return;
    }
    const readableCount = item.read_summary?.total ?? item.count;
    if (!readableCount) {
      toast.info(tFeature('addANoteBeforeStartingAReading'));
      return;
    }
    setReadingBusyId(item.id);
    try {
      const response = await fetch('/api/notes/study/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: createWebNoteRequestId('note_session'),
          mode: 'sequential',
          notebook_ids: [item.id],
          optional_count: Math.min(Math.max(readableCount, 1), 500),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.data?.session_id) {
        throw new Error(
          payload?.error?.message || tFeature('couldNotStartReading')
        );
      }
      router.push(`/notebooks/${item.id}/read/${payload.data.session_id}`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotStartReading')
      );
    } finally {
      setReadingBusyId(null);
    }
  }

  function resetFilters() {
    setQuery('');
    setSubjectFilter('all');
    setTypeFilter('all');
  }

  function openCreateDialog(kind: CreateKind = 'problem_set') {
    setCreateKind(kind);
    setCreateOpen(true);
  }

  return (
    <>
      <div className="section-container">
        <PageHeader
          title={tFeature('notebookShelf')}
          description={tFeature('questionNotebooksNotesAndVocabularyDecksLive')}
          actions={
            <Button onClick={() => openCreateDialog()}>
              <Plus className="mr-2 h-4 w-4" />
              {tFeature('new')}
            </Button>
          }
        />

        <div className="mt-6 rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={tFeature(
                  'searchQuestionNotebooksNotesDecksOrSubjects'
                )}
                className="pl-10"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:w-[29rem]">
              <Select value={subjectFilter} onValueChange={setSubjectFilter}>
                <SelectTrigger>
                  <SelectValue placeholder={tFeature('filterBySubject')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tFeature('allSubjects')}</SelectItem>
                  {subjects.map(subject => (
                    <SelectItem key={subject.id} value={subject.id}>
                      {subject.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={typeFilter}
                onValueChange={value => setTypeFilter(value as TypeFilter)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={tFeature('filterByType')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tFeature('allTypes')}</SelectItem>
                  <SelectItem value="problem_set">
                    {tFeature('questionNotebook')}
                  </SelectItem>
                  <SelectItem value="notebook">{tFeature('notes')}</SelectItem>
                  <SelectItem value="word_deck">
                    {tFeature('vocabularyDeck')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <SlidersHorizontal className="h-4 w-4" />
              <span>
                {tFeature('showing')}
                {filteredItems.length} {tFeature('items2')}
              </span>
              {hasFilters ? (
                <Badge variant="outline">{tFeature('filtered')}</Badge>
              ) : null}
            </div>
            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                {tFeature('clearFilters')}
              </Button>
            ) : null}
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed bg-muted/30 px-6 py-14 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border bg-background">
              <NotebookPen className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="mx-auto mt-4 max-w-md space-y-2">
              <h3 className="text-lg font-semibold">
                {items.length === 0
                  ? tFeature('theShelfIsEmpty')
                  : tFeature('noMatchingContent')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {items.length === 0
                  ? tFeature('createAQuestionNotebookToCollectQuestions')
                  : tFeature('tryAnotherKeywordSubjectOrContentType')}
              </p>
            </div>
            {items.length === 0 ? null : (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={resetFilters}>
                  {tFeature('clearFilters')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredItems.map(item => (
              <ShelfItemCard
                key={`${item.type}-${item.id}`}
                item={item}
                accessBusy={accessBusyId === item.id}
                readingBusy={readingBusyId === item.id}
                onOpen={() => openItem(item)}
                onContinue={() => startOrContinueReading(item)}
                onAiAccessChange={checked =>
                  handleAiAccessChange(item, checked)
                }
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tFeature('newContent')}</DialogTitle>
            <DialogDescription>
              {tFeature('chooseATypeAndANameThen')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                variant={createKind === 'problem_set' ? 'default' : 'outline'}
                onClick={() => setCreateKind('problem_set')}
              >
                <BookOpen className="mr-2 h-4 w-4" />
                {tFeature('questionNotebook')}
              </Button>
              <Button
                type="button"
                variant={createKind === 'notebook' ? 'default' : 'outline'}
                onClick={() => setCreateKind('notebook')}
              >
                <FileText className="mr-2 h-4 w-4" />
                {tFeature('notes')}
              </Button>
              <Button
                type="button"
                variant={createKind === 'word_deck' ? 'default' : 'outline'}
                onClick={() => setCreateKind('word_deck')}
              >
                <BookA className="mr-2 h-4 w-4" />
                {tFeature('vocabularyDeck')}
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-title">{tFeature('name')}</Label>
              <Input
                id="notebook-title"
                value={createTitle}
                onChange={event => setCreateTitle(event.target.value)}
                maxLength={80}
                placeholder={defaultTitlePlaceholder(createKind)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-subject">{tFeature('category')}</Label>
              <Select
                value={createSubjectId}
                onValueChange={setCreateSubjectId}
              >
                <SelectTrigger id="notebook-subject">
                  <SelectValue placeholder={tFeature('chooseACategory2')} />
                </SelectTrigger>
                <SelectContent>
                  {createKind === 'word_deck' ? (
                    <SelectItem value="_none">
                      {tFeature('noSubject')}
                    </SelectItem>
                  ) : null}
                  {subjects.map(subject => (
                    <SelectItem key={subject.id} value={subject.id}>
                      {subject.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {subjects.length === 0 && createKind !== 'word_deck' ? (
                <p className="text-xs text-muted-foreground">
                  {tFeature('noSubjectsAreAvailableYetContentCannot')}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {createKind === 'word_deck'
                    ? tFeature('vocabularyDecksCanHaveNoSubjectSubjects')
                    : tFeature('usedForFilteringAndOrganizingContent')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-description">
                {tFeature('description')}
              </Label>
              <Textarea
                id="notebook-description"
                value={createDescription}
                onChange={event => setCreateDescription(event.target.value)}
                maxLength={500}
                placeholder={tFeature('optional')}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={createBusy}
              >
                {tFeature('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={createBusy || subjects.length === 0}
              >
                {createBusy
                  ? tFeature('creating')
                  : createSubmitLabel(createKind)}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ShelfItemCard({
  item,
  accessBusy,
  readingBusy,
  onOpen,
  onContinue,
  onAiAccessChange,
}: {
  item: NotebookShelfItem;
  accessBusy: boolean;
  readingBusy: boolean;
  onOpen: () => void;
  onContinue: () => void;
  onAiAccessChange: (checked: boolean) => void;
}) {
  const tFeature = useFeatureTranslations('Notebooks.shelf');
  const featureLocale = useFeatureLocale();
  const typeLabels: Record<ShelfContentType, string> = {
    problem_set: tFeature('questionNotebook'),
    notebook: tFeature('notes'),
    word_deck: tFeature('vocabularyDeck'),
  };
  function formatUpdatedAt(value: string | null) {
    if (!value) return tFeature('noUpdatesYet');

    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return tFeature('noUpdatesYet');

    return new Intl.DateTimeFormat(featureLocale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }

  const isProblemSet = item.type === 'problem_set';
  const isWordDeck = item.type === 'word_deck';
  const isAiWritable = Boolean(item.ai_access?.can_create);

  return (
    <Card
      className={cn(
        'group cursor-pointer overflow-hidden rounded-lg border shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30',
        isProblemSet
          ? 'border-l-4 border-l-primary'
          : isWordDeck
            ? 'border-l-4 border-l-emerald-500'
            : 'border-l-4 border-l-sky-500'
      )}
      onClick={onOpen}
    >
      <CardHeader className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md',
                isProblemSet
                  ? 'bg-primary/10 text-primary'
                  : isWordDeck
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
              )}
            >
              {isProblemSet ? (
                <BookOpen className="h-5 w-5" />
              ) : isWordDeck ? (
                <BookA className="h-5 w-5" />
              ) : (
                <FileText className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <CardTitle className="truncate text-base leading-6">
                {item.title}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                <Badge variant={isProblemSet ? 'default' : 'secondary'}>
                  {typeLabels[item.type]}
                </Badge>
                <Badge variant="outline">
                  {item.subject_name || tFeature('uncategorized')}
                </Badge>
              </div>
            </div>
          </div>
          {!isProblemSet && !isWordDeck && isAiWritable ? (
            <Badge
              variant="outline"
              className="shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              <CheckCircle2 className="mr-1 h-3 w-3" />
              {tFeature('aiWritingAllowed')}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <p className="line-clamp-3 min-h-[3.75rem] text-sm leading-6 text-muted-foreground">
          {item.description ||
            (isProblemSet
              ? tFeature('collectRelatedQuestionsAndOrganizeTheirReview')
              : isWordDeck
                ? tFeature('manageWordsMeaningsAndExamplesDeviceVocabulary')
                : tFeature('recordKnowledgeSummariesAndIdeasOutsideThe'))}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md bg-muted/60 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              {isProblemSet
                ? tFeature('questionCount')
                : isWordDeck
                  ? tFeature('entryCount')
                  : tFeature('noteCount')}
            </p>
            <p className="mt-1 font-semibold">{item.count}</p>
          </div>
          <div className="rounded-md bg-muted/60 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              {tFeature('updated')}
            </p>
            <p className="mt-1 truncate font-medium">
              {formatUpdatedAt(item.updated_at)}
            </p>
          </div>
        </div>
        {!isProblemSet && !isWordDeck && item.read_summary ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">
              {tFeature('unread')}
              {item.read_summary.unread_count}
            </Badge>
            <Badge variant="outline">
              {tFeature('reading')}
              {item.read_summary.reading_count}
            </Badge>
            <Badge variant="secondary">
              {tFeature('read')}
              {item.read_summary.completed_count}
            </Badge>
          </div>
        ) : null}
      </CardContent>
      {!isProblemSet && !isWordDeck ? (
        <CardFooter
          className="flex-col items-stretch gap-3 border-t bg-muted/20 px-5 py-4"
          onClick={event => event.stopPropagation()}
        >
          <Button
            onClick={onContinue}
            disabled={
              readingBusy || (item.read_summary?.total ?? item.count) === 0
            }
          >
            <PlayCircle className="mr-2 h-4 w-4" />
            {readingBusy
              ? tFeature('preparing')
              : item.read_summary?.resumable_session_id
                ? tFeature('continueReading')
                : tFeature('startReading')}
          </Button>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {tFeature('aiWritingPermission')}
              </p>
              <p className="text-xs text-muted-foreground">
                {isAiWritable
                  ? tFeature('aiCanCreateNotes')
                  : tFeature('maintainedManually')}
              </p>
            </div>
            <Switch
              checked={isAiWritable}
              disabled={accessBusy}
              onCheckedChange={onAiAccessChange}
            />
          </div>
          {item.read_summary?.resume_note_title ||
          item.read_summary?.last_note_title ? (
            <p className="truncate text-xs text-muted-foreground">
              {item.read_summary.resume_note_title
                ? tFeature('continueAt', {
                    value0: String(item.read_summary.resume_note_title ?? ''),
                  })
                : tFeature('lastRead', {
                    value0: String(item.read_summary.last_note_title ?? ''),
                  })}
            </p>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

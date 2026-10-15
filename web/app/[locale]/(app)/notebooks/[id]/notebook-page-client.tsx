'use client';
import {
  useTranslations as useFeatureTranslations,
  useLocale as useFeatureLocale,
} from 'next-intl';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import { appendFromParam, isSafeInternalHref } from '@/lib/navigation-context';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  ImagePlus,
  Lock,
  Pencil,
  PlayCircle,
  Plus,
  Search,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { uploadNoteFiles } from '@/lib/storage/client';
import { createWebNoteRequestId } from '@/lib/note-study-client';
import type {
  NotebookReadSummary,
  RecentNoteRead,
  WebNoteStudySessionSummary,
} from '@/lib/note-study-web';

type NotebookView = {
  id: string;
  title: string;
  description: string | null;
  subject_id: string;
  subject_name: string;
  updated_at: string;
  revision: number;
  ai_access: { can_read: boolean; can_create: boolean; can_update: boolean };
};

type NoteImageAssetView = {
  path: string;
  image_id: string;
  display_path: string;
  preview_path: string;
};

type NoteView = {
  id: string;
  notebook_id: string;
  title: string;
  content: string;
  content_format?: string;
  source: string;
  linked_problem_id: string | null;
  linked_problem?: {
    problem_id: string;
    problem_set_id: string | null;
    subject_id: string;
    title: string;
    status: string;
  } | null;
  read_state?: {
    state: 'unread' | 'reading' | 'completed';
    last_opened_at: string | null;
    last_completed_at: string | null;
    completed_count: number;
  };
  assets?: NoteImageAssetView[];
  revision: number;
  sort_index: number;
  created_at: string;
  updated_at: string;
};

type NoteListOrder = 'stable' | 'updated_desc' | 'title';

export default function NotebookPageClient({
  notebook: initialNotebook,
  initialNotes,
  initialReadSummary,
  initialRecentReads,
  initialResumableSession,
}: {
  notebook: NotebookView;
  initialNotes: NoteView[];
  initialReadSummary: NotebookReadSummary;
  initialRecentReads: RecentNoteRead[];
  initialResumableSession: WebNoteStudySessionSummary | null;
}) {
  const tFeature = useFeatureTranslations('Notes');
  const featureLocale = useFeatureLocale();
  const ORDER_LABELS: Record<NoteListOrder, string> = {
    stable: tFeature('stableOrder'),
    updated_desc: tFeature('recentlyUpdated'),
    title: tFeature('title'),
  };
  const SOURCE_LABELS: Record<string, string> = {
    ai: tFeature('createdByAi'),
    user: tFeature('createdManually'),
    import: tFeature('import'),
  };
  function formatDateTime(value: string) {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return tFeature('unknownTime');
    return new Intl.DateTimeFormat(featureLocale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }

  const router = useRouter();
  const from = useSearchParams().get('from');
  const backHref = from && isSafeInternalHref(from) ? from : '/subjects';
  const notebookHref = appendFromParam(
    `/notebooks/${initialNotebook.id}`,
    backHref
  );
  const [notebook, setNotebook] = useState(initialNotebook);
  const [notes, setNotes] = useState(initialNotes);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [order, setOrder] = useState<NoteListOrder>('stable');
  const [query, setQuery] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const [readSummary] = useState(initialReadSummary);
  const [recentReads] = useState(initialRecentReads);
  const [resumableSession, setResumableSession] = useState(
    initialResumableSession
  );
  const [readingBusy, setReadingBusy] = useState(false);

  const [aiAccess, setAiAccess] = useState(initialNotebook.ai_access);
  const [aiBusy, setAiBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const [editNote, setEditNote] = useState<NoteView | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editAssets, setEditAssets] = useState<NoteImageAssetView[]>([]);
  const [editBusy, setEditBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Fullscreen viewer: original image by default, e-ink render on toggle;
  // fit-to-screen vs 1:1 (scroll/drag to pan) covers desktop and touch zoom.
  const [viewerAsset, setViewerAsset] = useState<NoteImageAssetView | null>(
    null
  );
  const [viewerShowEink, setViewerShowEink] = useState(false);
  const [viewerActualSize, setViewerActualSize] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTitle, setSettingsTitle] = useState(initialNotebook.title);
  const [settingsDescription, setSettingsDescription] = useState(
    initialNotebook.description || ''
  );
  const [settingsBusy, setSettingsBusy] = useState(false);

  async function startOrContinueReading() {
    if (resumableSession) {
      router.push(
        appendFromParam(
          `/notebooks/${notebook.id}/read/${resumableSession.session_id}`,
          notebookHref
        )
      );
      return;
    }
    if (!readSummary.total) {
      toast.info(tFeature('addANoteBeforeStartingAReading'));
      return;
    }
    setReadingBusy(true);
    try {
      const response = await fetch('/api/notes/study/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: createWebNoteRequestId('note_session'),
          mode: 'sequential',
          notebook_ids: [notebook.id],
          optional_count: Math.min(readSummary.total, 500),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.data?.session_id) {
        throw new Error(
          payload?.error?.message || tFeature('couldNotStartReading')
        );
      }
      const sessionId = payload.data.session_id as string;
      setResumableSession({
        session_id: sessionId,
        mode: 'sequential',
        status: 'active',
        notebook_ids: [notebook.id],
        notebook_titles: [notebook.title],
        candidate_count: Number(
          payload.data.candidate_count || readSummary.total
        ),
        next_sequence: Number(payload.data.next_sequence || 0),
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        device_id: null,
        current_note_id: payload.data.items?.[0]?.item_id || null,
        current_note_title: null,
      });
      router.push(
        appendFromParam(
          `/notebooks/${notebook.id}/read/${sessionId}`,
          notebookHref
        )
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotStartReading')
      );
    } finally {
      setReadingBusy(false);
    }
  }

  // The list is API-managed after first paint so search / order / pagination all
  // share one canonical cursor source instead of the SSR snapshot.
  const loadPage = useCallback(
    async (
      options: { reset: boolean; searchTerm?: string } = { reset: true }
    ) => {
      setListBusy(true);
      try {
        const params = new URLSearchParams();
        params.set('order', order);
        params.set('limit', '50');
        const term = options.searchTerm ?? query;
        if (term.trim()) params.set('query', term.trim());
        if (!options.reset && cursor) params.set('cursor', cursor);

        const response = await fetch(
          `/api/notebooks/${notebook.id}/notes?${params.toString()}`,
          { cache: 'no-store' }
        );
        if (!response.ok) throw new Error(tFeature('couldNotLoadNotes'));
        const payload = await response.json();
        const data = payload.data || {};
        const pageNotes: NoteView[] = data.notes || [];
        setNotes(prev => (options.reset ? pageNotes : [...prev, ...pageNotes]));
        setCursor(data.next_cursor ?? null);
        setHasMore(Boolean(data.has_more));
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : tFeature('couldNotLoadNotes')
        );
      } finally {
        setListBusy(false);
      }
    },
    [cursor, notebook.id, order, query, tFeature]
  );

  // Refetch page 1 whenever the ordering changes (and once on mount).
  const didMount = useRef(false);
  useEffect(() => {
    loadPage({ reset: true });
    didMount.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);

  async function updateAiAccess(enabled: boolean) {
    setAiBusy(true);
    try {
      const response = await fetch(`/api/notebooks/${notebook.id}/ai-access`, {
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
      setAiAccess({
        can_read: enabled,
        can_create: enabled,
        can_update: false,
      });
      toast.success(
        enabled
          ? tFeature('aiCanNowCreateNotes')
          : tFeature('aiPermissionRemoved')
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotUpdateAiPermissions')
      );
    } finally {
      setAiBusy(false);
    }
  }

  async function createNote(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !content.trim()) {
      toast.error(tFeature('enterATitleAndContent'));
      return;
    }
    setCreateBusy(true);
    try {
      const response = await fetch(`/api/notebooks/${notebook.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), content }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || tFeature('couldNotCreateTheNote'));
      }
      const payload = await response.json().catch(() => null);
      setCreateOpen(false);
      setTitle('');
      setContent('');
      toast.success(tFeature('noteCreatedYouCanNowAddImages'));
      await loadPage({ reset: true });
      router.refresh();
      // Images can only be attached to an existing note (the storage path
      // needs the note id), so hand the fresh note straight to the edit
      // dialog where the image section lives.
      const created = payload?.data?.note;
      if (created?.id) {
        openEdit(created as NoteView);
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotCreateTheNote')
      );
    } finally {
      setCreateBusy(false);
    }
  }

  function openEdit(note: NoteView) {
    setEditNote(note);
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditAssets(note.assets ?? []);
  }

  // Image attach/detach bump the note revision server-side, so every response
  // must be folded back into editNote or the next content save hits a 409.
  function applyNotePayload(payload: any) {
    const note = payload?.data?.note;
    if (!note) return;
    setEditNote(prev => (prev ? { ...prev, revision: note.revision } : prev));
    setEditAssets(Array.isArray(note.assets) ? note.assets : []);
  }

  async function handleImageUpload(files: FileList) {
    if (!editNote || files.length === 0) return;
    if (editAssets.length + files.length > 4) {
      toast.error(tFeature('eachNoteSupportsUpToFourImages'));
      return;
    }
    setImageBusy(true);
    try {
      for (const file of Array.from(files)) {
        const [path] = await uploadNoteFiles([file], editNote.id);
        const response = await fetch(
          `/api/notebooks/${notebook.id}/notes/${editNote.id}/images`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          }
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            payload?.message || tFeature('couldNotProcessTheImage')
          );
        }
        applyNotePayload(payload);
      }
      toast.success(tFeature('imageAddedThePreviewMatchesTheE'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotUploadTheImage')
      );
    } finally {
      setImageBusy(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  }

  async function handleImageDelete(imageId: string) {
    if (!editNote) return;
    setImageBusy(true);
    try {
      const response = await fetch(
        `/api/notebooks/${notebook.id}/notes/${editNote.id}/images/${imageId}`,
        { method: 'DELETE' }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || tFeature('couldNotDeleteTheImage'));
      }
      applyNotePayload(payload);
      toast.success(tFeature('imageDeleted'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotDeleteTheImage')
      );
    } finally {
      setImageBusy(false);
    }
  }

  async function submitEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editNote) return;
    if (!editTitle.trim() || !editContent.trim()) {
      toast.error(tFeature('enterATitleAndContent'));
      return;
    }
    setEditBusy(true);
    try {
      const response = await fetch(
        `/api/notebooks/${notebook.id}/notes/${editNote.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expected_revision: editNote.revision,
            title: editTitle.trim(),
            content: editContent,
          }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        // Revision conflict: another writer won. Reload so the user edits the
        // current version instead of silently overwriting it.
        toast.error(tFeature('thisNoteChangedElsewhereTheLatestContent'));
        setEditNote(null);
        await loadPage({ reset: true });
        return;
      }
      if (!response.ok) {
        throw new Error(payload?.message || tFeature('couldNotSaveTheNote'));
      }
      toast.success(tFeature('noteUpdated'));
      setEditNote(null);
      await loadPage({ reset: true });
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tFeature('couldNotSaveTheNote')
      );
    } finally {
      setEditBusy(false);
    }
  }

  async function submitSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!settingsTitle.trim()) {
      toast.error(tFeature('enterANotebookName'));
      return;
    }
    setSettingsBusy(true);
    try {
      const response = await fetch(`/api/notebooks/${notebook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_revision: notebook.revision,
          title: settingsTitle.trim(),
          description: settingsDescription.trim() || null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        toast.error(tFeature('thisNotebookChangedElsewhereRefreshAndRetry'));
        router.refresh();
        return;
      }
      if (!response.ok) {
        throw new Error(
          payload?.message || tFeature('couldNotSaveTheNotebook')
        );
      }
      const updated = payload.data?.notebook;
      setNotebook(prev => ({
        ...prev,
        title: updated?.title ?? settingsTitle.trim(),
        description: updated?.description ?? null,
        revision: updated?.revision ?? prev.revision + 1,
      }));
      toast.success(tFeature('notebookUpdated'));
      setSettingsOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotSaveTheNotebook')
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  return (
    <>
      <div className="section-container">
        <PageHeader
          title={notebook.title}
          description={
            <span className="space-y-1">
              <span className="block">
                {notebook.subject_name || tFeature('uncategorized')}{' '}
                {tFeature('notebookRevisionV')}
                {notebook.revision}
              </span>
              {notebook.description ? (
                <span className="block">{notebook.description}</span>
              ) : null}
            </span>
          }
          actions={
            <>
              <Button variant="outline" onClick={() => router.push(backHref)}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                {tFeature('backToShelf')}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSettingsTitle(notebook.title);
                  setSettingsDescription(notebook.description || '');
                  setSettingsOpen(true);
                }}
              >
                <Settings2 className="mr-2 h-4 w-4" />
                {tFeature('notebookSettings')}
              </Button>
              <Button
                variant="outline"
                disabled={readingBusy || readSummary.total === 0}
                onClick={startOrContinueReading}
              >
                <PlayCircle className="mr-2 h-4 w-4" />
                {readingBusy
                  ? tFeature('preparing')
                  : resumableSession
                    ? tFeature('continueReading')
                    : tFeature('startReading')}
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {tFeature('newNote')}
              </Button>
            </>
          }
        />

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card className="rounded-lg shadow-sm">
            <CardHeader className="border-b p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">
                    {tFeature('noteOverview')}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {tFeature('notesStoreKnowledgeSummariesAndAiConversation')}
                  </p>
                </div>
                <Badge variant="secondary">{tFeature('notes')}</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 p-5 sm:grid-cols-4">
              <NotebookMetric
                label={tFeature('totalNotes')}
                value={readSummary.total}
              />
              <NotebookMetric
                label={tFeature('unread')}
                value={readSummary.unread_count}
              />
              <NotebookMetric
                label={tFeature('reading')}
                value={readSummary.reading_count}
              />
              <NotebookMetric
                label={tFeature('read')}
                value={readSummary.completed_count}
              />
            </CardContent>
          </Card>

          <Card className="rounded-lg shadow-sm">
            <CardHeader className="border-b p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-base">
                    {tFeature('aiPermissions')}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tFeature('allowWqnNote4AiConversationsTo')}
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  {aiAccess.can_create ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Lock className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium">
                    {aiAccess.can_create
                      ? tFeature('writingAllowed')
                      : tFeature('writingNotAllowed')}
                  </span>
                </div>
                <Switch
                  checked={aiAccess.can_create}
                  disabled={aiBusy}
                  onCheckedChange={updateAiAccess}
                />
              </div>
              <div className="rounded-md bg-muted/60 p-3 text-xs leading-5 text-muted-foreground">
                {aiAccess.can_create
                  ? tFeature('aiCanCheckThisNotebookSPermissions')
                  : tFeature('whenDisabledAiConversationsCannotCreateNotes')}
              </div>
            </CardContent>
          </Card>
        </div>

        {recentReads.length ? (
          <Card className="mt-4 rounded-lg shadow-sm">
            <CardHeader className="border-b p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {tFeature('recentReading')}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tFeature('webAndNote4ShareTheSame')}
                  </p>
                </div>
                {resumableSession?.current_note_title ||
                readSummary.last_note_title ? (
                  <Badge variant="outline">
                    {resumableSession?.current_note_title
                      ? tFeature('continueAt', {
                          value0: String(
                            resumableSession.current_note_title ?? ''
                          ),
                        })
                      : tFeature('lastRead', {
                          value0: String(readSummary.last_note_title ?? ''),
                        })}
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="grid gap-2 p-5 sm:grid-cols-2">
              {recentReads.slice(0, 6).map(item => (
                <div
                  key={item.note_id}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {item.note_title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(item.last_opened_at)} ·{' '}
                      {item.actor === 'note4'
                        ? 'NOTE 4'
                        : item.actor === 'web'
                          ? 'Web'
                          : tFeature('synced')}
                    </p>
                  </div>
                  <Badge
                    variant={
                      item.state === 'completed' ? 'secondary' : 'outline'
                    }
                  >
                    {item.state === 'completed'
                      ? tFeature('read')
                      : tFeature('reading')}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={event => {
              event.preventDefault();
              loadPage({ reset: true });
            }}
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={tFeature('searchTitlesOrContent')}
                className="pl-9"
              />
            </div>
            <Button type="submit" variant="outline" disabled={listBusy}>
              {tFeature('search')}
            </Button>
          </form>
          <div className="flex items-center gap-1 rounded-md border p-1">
            {(Object.keys(ORDER_LABELS) as NoteListOrder[]).map(value => (
              <Button
                key={value}
                size="sm"
                variant={order === value ? 'default' : 'ghost'}
                onClick={() => setOrder(value)}
                disabled={listBusy}
              >
                {ORDER_LABELS[value]}
              </Button>
            ))}
          </div>
        </div>

        {notes.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed bg-muted/30 px-6 py-14 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border bg-background">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="mx-auto mt-4 max-w-md space-y-2">
              <h3 className="text-lg font-semibold">
                {query.trim()
                  ? tFeature('noMatchingNotes')
                  : tFeature('noNotesYet')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {tFeature('addANoteManuallyOrEnableAi')}
              </p>
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {tFeature('newNote')}
              </Button>
              {!aiAccess.can_create ? (
                <Button
                  variant="outline"
                  disabled={aiBusy}
                  onClick={() => updateAiAccess(true)}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  {tFeature('allowAiToCreateNotes')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{tFeature('noteList')}</h2>
              <p className="text-sm text-muted-foreground">
                {tFeature('loaded')}
                {notes.length} {tFeature('notes2')}
                {ORDER_LABELS[order]}
              </p>
            </div>
            {notes.map(note => (
              <Card
                key={note.id}
                data-testid="note-card"
                className="rounded-lg shadow-sm"
              >
                <CardHeader className="space-y-3 border-b p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <CardTitle className="text-base leading-6">
                        {note.title}
                      </CardTitle>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">
                          {SOURCE_LABELS[note.source] || note.source}
                        </Badge>
                        {note.linked_problem_id ? (
                          <Badge variant="secondary">
                            {tFeature('linkedQuestion')}
                          </Badge>
                        ) : null}
                        <Badge
                          variant={
                            note.read_state?.state === 'completed'
                              ? 'secondary'
                              : 'outline'
                          }
                        >
                          {note.read_state?.state === 'completed'
                            ? tFeature('read')
                            : note.read_state?.state === 'reading'
                              ? tFeature('reading')
                              : tFeature('unread')}
                        </Badge>
                        <Badge variant="outline">v{note.revision}</Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock3 className="h-3.5 w-3.5" />
                        {formatDateTime(note.updated_at)}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(note)}
                      >
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        {tFeature('edit')}
                      </Button>
                      {note.linked_problem ? (
                        <Button size="sm" variant="ghost" asChild>
                          <Link
                            href={
                              note.linked_problem.problem_set_id
                                ? `/problem-sets/${note.linked_problem.problem_set_id}/review?problemId=${note.linked_problem.problem_id}`
                                : `/subjects/${note.linked_problem.subject_id}/problems/${note.linked_problem.problem_id}/review`
                            }
                          >
                            <ExternalLink className="mr-1 h-3.5 w-3.5" />
                            {tFeature('linkedQuestion')}
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-5">
                  {/* plain_text_v1: escape HTML (React default) and preserve
                      newlines; never interpret note content as markup. */}
                  <p className="whitespace-pre-wrap break-words text-sm leading-7">
                    {note.content}
                  </p>
                  {Array.isArray(note.assets) && note.assets.length > 0 ? (
                    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {note.assets.map(asset => (
                        <button
                          type="button"
                          key={asset.image_id}
                          onClick={() => {
                            setViewerAsset(asset);
                            setViewerShowEink(false);
                            setViewerActualSize(false);
                          }}
                          className="overflow-hidden rounded-md border border-gray-200 transition hover:opacity-80 dark:border-gray-700"
                          title={tFeature('viewFullScreen')}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/files/${encodeURIComponent(asset.path)}`}
                            alt={tFeature('noteImage')}
                            className="aspect-[4/3] w-full bg-white object-contain"
                          />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
                <CardFooter className="border-t bg-muted/20 px-5 py-3 text-xs text-muted-foreground">
                  {tFeature('created')}
                  {formatDateTime(note.created_at)}
                  {note.read_state?.last_opened_at
                    ? tFeature('lastRead2', {
                        value0: String(
                          formatDateTime(note.read_state.last_opened_at) ?? ''
                        ),
                      })
                    : ''}
                </CardFooter>
              </Card>
            ))}
            {hasMore ? (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  disabled={listBusy}
                  onClick={() => loadPage({ reset: false })}
                >
                  {listBusy ? tFeature('loading') : tFeature('loadMore')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tFeature('newNote')}</DialogTitle>
            <DialogDescription>
              {tFeature('notesStoreInformationAndDoNotAffect')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createNote} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="note-title">{tFeature('title')}</Label>
              <Input
                id="note-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                maxLength={120}
                placeholder={tFeature('chainRuleForDerivatives')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="note-content">{tFeature('content')}</Label>
              <Textarea
                id="note-content"
                value={content}
                onChange={event => setContent(event.target.value)}
                maxLength={4000}
                className="min-h-40"
                placeholder={tFeature(
                  'recordKnowledgeCommonMistakesOrASummary'
                )}
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
              <Button type="submit" disabled={createBusy}>
                {createBusy ? tFeature('creating') : tFeature('create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editNote !== null}
        onOpenChange={open => !open && setEditNote(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tFeature('editNote')}</DialogTitle>
            <DialogDescription>
              {tFeature('savingChecksTheRevisionChangesMadeElsewhere')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitEdit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-note-title">{tFeature('title')}</Label>
              <Input
                id="edit-note-title"
                value={editTitle}
                onChange={event => setEditTitle(event.target.value)}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-note-content">{tFeature('content')}</Label>
              <Textarea
                id="edit-note-content"
                value={editContent}
                onChange={event => setEditContent(event.target.value)}
                maxLength={4000}
                className="min-h-40"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>
                  {tFeature('images')}
                  {editAssets.length}
                  {tFeature('4PreviewMatchesTheEInkDisplay')}
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={imageBusy || editAssets.length >= 4}
                  onClick={() => imageInputRef.current?.click()}
                >
                  <ImagePlus className="mr-1 h-4 w-4" />
                  {imageBusy ? tFeature('processing') : tFeature('addImage')}
                </Button>
              </div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-label={tFeature('noteImage')}
                multiple
                className="hidden"
                onChange={event =>
                  event.target.files && handleImageUpload(event.target.files)
                }
              />
              {editAssets.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {editAssets.map(asset => (
                    <div
                      key={asset.image_id}
                      className="relative rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/files/${encodeURIComponent(asset.preview_path)}`}
                        alt={tFeature('eInkPreview')}
                        className="w-full aspect-[4/3] object-contain bg-white"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={imageBusy}
                        onClick={() => handleImageDelete(asset.image_id)}
                        className="absolute top-1 right-1 h-6 w-6 p-0 bg-white/80 hover:bg-white text-red-600"
                        title={tFeature('deleteImage')}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditNote(null)}
                disabled={editBusy}
              >
                {tFeature('cancel')}
              </Button>
              <Button type="submit" disabled={editBusy}>
                {editBusy ? tFeature('saving') : tFeature('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tFeature('notebookSettings')}</DialogTitle>
            <DialogDescription>
              {tFeature('renameOrChangeTheDescriptionSavingChecks')}
              {notebook.revision}。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitSettings} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="notebook-title">{tFeature('name')}</Label>
              <Input
                id="notebook-title"
                value={settingsTitle}
                onChange={event => setSettingsTitle(event.target.value)}
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-description">
                {tFeature('description')}
              </Label>
              <Textarea
                id="notebook-description"
                value={settingsDescription}
                onChange={event => setSettingsDescription(event.target.value)}
                maxLength={1000}
                className="min-h-24"
                placeholder={tFeature('optionalDescribeWhatThisNotebookIsFor')}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSettingsOpen(false)}
                disabled={settingsBusy}
              >
                {tFeature('cancel')}
              </Button>
              <Button type="submit" disabled={settingsBusy}>
                {settingsBusy ? tFeature('saving') : tFeature('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {viewerAsset ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
          onClick={() => setViewerAsset(null)}
        >
          <div
            className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm text-white"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={viewerShowEink ? 'outline' : 'secondary'}
                onClick={() => setViewerShowEink(false)}
              >
                {tFeature('originalImage')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={viewerShowEink ? 'secondary' : 'outline'}
                onClick={() => setViewerShowEink(true)}
              >
                {tFeature('eInkPreview')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setViewerActualSize(value => !value)}
              >
                {viewerActualSize ? tFeature('fitScreen') : tFeature('11Zoom')}
              </Button>
              <a
                href={`/api/files/${encodeURIComponent(
                  viewerShowEink ? viewerAsset.preview_path : viewerAsset.path
                )}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-gray-300 underline-offset-2 hover:underline"
              >
                {tFeature('openInNewTab')}
              </a>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-white hover:bg-white/10"
              onClick={() => setViewerAsset(null)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div
            className={
              viewerActualSize
                ? 'flex-1 overflow-auto p-3'
                : 'flex flex-1 items-center justify-center overflow-hidden p-3'
            }
            onClick={event => event.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/files/${encodeURIComponent(
                viewerShowEink ? viewerAsset.preview_path : viewerAsset.path
              )}`}
              alt={
                viewerShowEink ? tFeature('eInkPreview') : tFeature('noteImage')
              }
              className={
                viewerActualSize
                  ? 'mx-auto max-w-none cursor-zoom-out bg-white'
                  : 'max-h-full max-w-full cursor-zoom-in bg-white object-contain'
              }
              onClick={() => setViewerActualSize(value => !value)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function NotebookMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/60 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

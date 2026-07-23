'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock3,
  FileText,
  Lock,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

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

type NoteView = {
  id: string;
  notebook_id: string;
  title: string;
  content: string;
  content_format?: string;
  source: string;
  linked_problem_id: string | null;
  revision: number;
  sort_index: number;
  created_at: string;
  updated_at: string;
};

type NoteListOrder = 'stable' | 'updated_desc' | 'title';

const ORDER_LABELS: Record<NoteListOrder, string> = {
  stable: '稳定顺序',
  updated_desc: '最近更新',
  title: '标题',
};

const SOURCE_LABELS: Record<string, string> = {
  ai: 'AI 创建',
  user: '手动创建',
  import: '导入',
};

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export default function NotebookPageClient({
  notebook: initialNotebook,
  initialNotes,
}: {
  notebook: NotebookView;
  initialNotes: NoteView[];
}) {
  const router = useRouter();
  const [notebook, setNotebook] = useState(initialNotebook);
  const [notes, setNotes] = useState(initialNotes);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [order, setOrder] = useState<NoteListOrder>('stable');
  const [query, setQuery] = useState('');
  const [listBusy, setListBusy] = useState(false);

  const [aiAccess, setAiAccess] = useState(initialNotebook.ai_access);
  const [aiBusy, setAiBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const [editNote, setEditNote] = useState<NoteView | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTitle, setSettingsTitle] = useState(initialNotebook.title);
  const [settingsDescription, setSettingsDescription] = useState(
    initialNotebook.description || ''
  );
  const [settingsBusy, setSettingsBusy] = useState(false);

  const noteCounts = useMemo(
    () => ({
      total: notes.length,
      ai: notes.filter(note => note.source === 'ai').length,
      user: notes.filter(note => note.source !== 'ai').length,
    }),
    [notes]
  );

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
        if (!response.ok) throw new Error('加载笔记失败');
        const payload = await response.json();
        const data = payload.data || {};
        const pageNotes: NoteView[] = data.notes || [];
        setNotes(prev => (options.reset ? pageNotes : [...prev, ...pageNotes]));
        setCursor(data.next_cursor ?? null);
        setHasMore(Boolean(data.has_more));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '加载笔记失败');
      } finally {
        setListBusy(false);
      }
    },
    [cursor, notebook.id, order, query]
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
        throw new Error(payload?.message || '更新 AI 授权失败');
      }
      setAiAccess({
        can_read: enabled,
        can_create: enabled,
        can_update: false,
      });
      toast.success(enabled ? '已授权 AI 写入' : '已取消 AI 授权');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新 AI 授权失败');
    } finally {
      setAiBusy(false);
    }
  }

  async function createNote(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !content.trim()) {
      toast.error('请输入标题和内容');
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
        throw new Error(payload?.message || '创建笔记失败');
      }
      setCreateOpen(false);
      setTitle('');
      setContent('');
      toast.success('笔记已创建');
      await loadPage({ reset: true });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建笔记失败');
    } finally {
      setCreateBusy(false);
    }
  }

  function openEdit(note: NoteView) {
    setEditNote(note);
    setEditTitle(note.title);
    setEditContent(note.content);
  }

  async function submitEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editNote) return;
    if (!editTitle.trim() || !editContent.trim()) {
      toast.error('请输入标题和内容');
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
        toast.error('这条笔记已被其他地方修改，已为你重新加载最新内容');
        setEditNote(null);
        await loadPage({ reset: true });
        return;
      }
      if (!response.ok) {
        throw new Error(payload?.message || '保存笔记失败');
      }
      toast.success('笔记已更新');
      setEditNote(null);
      await loadPage({ reset: true });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存笔记失败');
    } finally {
      setEditBusy(false);
    }
  }

  async function submitSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!settingsTitle.trim()) {
      toast.error('请输入笔记本名称');
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
        toast.error('笔记本已被修改，请刷新后重试');
        router.refresh();
        return;
      }
      if (!response.ok) {
        throw new Error(payload?.message || '保存笔记本失败');
      }
      const updated = payload.data?.notebook;
      setNotebook(prev => ({
        ...prev,
        title: updated?.title ?? settingsTitle.trim(),
        description: updated?.description ?? null,
        revision: updated?.revision ?? prev.revision + 1,
      }));
      toast.success('笔记本已更新');
      setSettingsOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存笔记本失败');
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
                {notebook.subject_name || '未分类'} / 空白笔记本 · 版本 v
                {notebook.revision}
              </span>
              {notebook.description ? (
                <span className="block">{notebook.description}</span>
              ) : null}
            </span>
          }
          actions={
            <>
              <Button
                variant="outline"
                onClick={() => router.push('/subjects')}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                返回笔记本架
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
                笔记本设置
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                新笔记
              </Button>
            </>
          }
        />

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card className="rounded-lg shadow-sm">
            <CardHeader className="border-b p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">笔记概览</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    空白笔记用于沉淀知识点、摘要和 AI
                    会话结果，不参与错题复习算法。
                  </p>
                </div>
                <Badge variant="secondary">空白笔记</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 p-5 sm:grid-cols-3">
              <NotebookMetric label="当前加载" value={noteCounts.total} />
              <NotebookMetric label="AI 生成" value={noteCounts.ai} />
              <NotebookMetric label="手动创建" value={noteCounts.user} />
            </CardContent>
          </Card>

          <Card className="rounded-lg shadow-sm">
            <CardHeader className="border-b p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-base">AI 授权</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    控制 WQN NOTE 4 AI 会话是否能向这个笔记本写入知识点。
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
                    {aiAccess.can_create ? '已允许写入' : '未授权写入'}
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
                  ? 'AI 可读取这个笔记本的授权状态，并在会话中创建新笔记；不会自动修改已有笔记。'
                  : '关闭后，AI 会话不会把内容写入这个笔记本，你仍然可以手动新增笔记。'}
              </div>
            </CardContent>
          </Card>
        </div>

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
                placeholder="搜索标题或正文"
                className="pl-9"
              />
            </div>
            <Button type="submit" variant="outline" disabled={listBusy}>
              搜索
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
                {query.trim() ? '没有匹配的笔记' : '还没有笔记'}
              </h3>
              <p className="text-sm text-muted-foreground">
                可以先手动新增一条笔记；如果开启 AI
                授权，会话也可以把遗漏知识点稳定写到这里。
              </p>
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                新笔记
              </Button>
              {!aiAccess.can_create ? (
                <Button
                  variant="outline"
                  disabled={aiBusy}
                  onClick={() => updateAiAccess(true)}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  允许 AI 写入
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">笔记列表</h2>
              <p className="text-sm text-muted-foreground">
                已加载 {notes.length} 条 · {ORDER_LABELS[order]}
              </p>
            </div>
            {notes.map(note => (
              <Card key={note.id} className="rounded-lg shadow-sm">
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
                          <Badge variant="secondary">关联错题</Badge>
                        ) : null}
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
                        编辑
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-5">
                  {/* plain_text_v1: escape HTML (React default) and preserve
                      newlines; never interpret note content as markup. */}
                  <p className="whitespace-pre-wrap break-words text-sm leading-7">
                    {note.content}
                  </p>
                </CardContent>
                <CardFooter className="border-t bg-muted/20 px-5 py-3 text-xs text-muted-foreground">
                  创建于 {formatDateTime(note.created_at)}
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
                  {listBusy ? '加载中...' : '加载更多'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新笔记</DialogTitle>
            <DialogDescription>
              空白笔记只做记录，不参与错题复习和推荐算法。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createNote} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="note-title">标题</Label>
              <Input
                id="note-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                maxLength={120}
                placeholder="导数链式法则"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="note-content">内容</Label>
              <Textarea
                id="note-content"
                value={content}
                onChange={event => setContent(event.target.value)}
                maxLength={4000}
                className="min-h-40"
                placeholder="记录知识点、易错点或总结。"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={createBusy}
              >
                取消
              </Button>
              <Button type="submit" disabled={createBusy}>
                {createBusy ? '创建中...' : '创建'}
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
            <DialogTitle>编辑笔记</DialogTitle>
            <DialogDescription>
              保存时会校验版本，若他处已修改会提示重新加载。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitEdit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-note-title">标题</Label>
              <Input
                id="edit-note-title"
                value={editTitle}
                onChange={event => setEditTitle(event.target.value)}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-note-content">内容</Label>
              <Textarea
                id="edit-note-content"
                value={editContent}
                onChange={event => setEditContent(event.target.value)}
                maxLength={4000}
                className="min-h-40"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditNote(null)}
                disabled={editBusy}
              >
                取消
              </Button>
              <Button type="submit" disabled={editBusy}>
                {editBusy ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>笔记本设置</DialogTitle>
            <DialogDescription>
              重命名或修改描述。保存时校验版本 v{notebook.revision}。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitSettings} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="notebook-title">名称</Label>
              <Input
                id="notebook-title"
                value={settingsTitle}
                onChange={event => setSettingsTitle(event.target.value)}
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-description">描述</Label>
              <Textarea
                id="notebook-description"
                value={settingsDescription}
                onChange={event => setSettingsDescription(event.target.value)}
                maxLength={1000}
                className="min-h-24"
                placeholder="可选：这个笔记本用来记录什么。"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSettingsOpen(false)}
                disabled={settingsBusy}
              >
                取消
              </Button>
              <Button type="submit" disabled={settingsBusy}>
                {settingsBusy ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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

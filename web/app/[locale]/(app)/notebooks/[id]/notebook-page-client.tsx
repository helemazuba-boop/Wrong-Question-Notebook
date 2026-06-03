'use client';

import { useMemo, useState } from 'react';
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
import { RichTextDisplay } from '@/components/ui/rich-text-display';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock3,
  FileText,
  Lock,
  Plus,
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
  ai_access: {
    can_read: boolean;
    can_create: boolean;
    can_update: boolean;
  };
};

type NoteView = {
  id: string;
  notebook_id: string;
  title: string;
  content: string;
  source: string;
  linked_problem_id: string | null;
  created_at: string;
  updated_at: string;
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
  notebook,
  initialNotes,
}: {
  notebook: NotebookView;
  initialNotes: NoteView[];
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [aiAccess, setAiAccess] = useState(notebook.ai_access);
  const [aiBusy, setAiBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const noteCounts = useMemo(
    () => ({
      total: notes.length,
      ai: notes.filter(note => note.source === 'ai').length,
      user: notes.filter(note => note.source !== 'ai').length,
    }),
    [notes]
  );

  async function refreshNotes() {
    const response = await fetch(`/api/notebooks/${notebook.id}/notes`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Failed to refresh notes');
    const payload = await response.json();
    setNotes(payload.data?.notes || []);
    router.refresh();
  }

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
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || '创建笔记失败');
      }
      setCreateOpen(false);
      setTitle('');
      setContent('');
      toast.success('笔记已创建');
      await refreshNotes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建笔记失败');
    } finally {
      setCreateBusy(false);
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
                {notebook.subject_name || '未分类'} / 空白笔记本
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
              <NotebookMetric label="全部笔记" value={noteCounts.total} />
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

        {notes.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed bg-muted/30 px-6 py-14 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border bg-background">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="mx-auto mt-4 max-w-md space-y-2">
              <h3 className="text-lg font-semibold">还没有笔记</h3>
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
                共 {notes.length} 条，按最近更新排序
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
                          {note.source === 'ai' ? 'AI 创建' : '手动创建'}
                        </Badge>
                        {note.linked_problem_id ? (
                          <Badge variant="secondary">关联错题</Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock3 className="h-3.5 w-3.5" />
                      {formatDateTime(note.updated_at)}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-5">
                  <RichTextDisplay
                    content={note.content}
                    className="prose prose-sm dark:prose-invert max-w-none leading-7"
                  />
                </CardContent>
                <CardFooter className="border-t bg-muted/20 px-5 py-3 text-xs text-muted-foreground">
                  创建于 {formatDateTime(note.created_at)}
                </CardFooter>
              </Card>
            ))}
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

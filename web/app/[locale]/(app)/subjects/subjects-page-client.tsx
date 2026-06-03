'use client';

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
import {
  findDefaultSubjectId,
  sortSubjectsByPresetOrder,
} from '@/lib/subject-presets';
import type { SubjectWithMetadata } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  BookOpen,
  Bot,
  CheckCircle2,
  FileText,
  NotebookPen,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';

type CreateKind = 'problem_set' | 'notebook';
type TypeFilter = 'all' | CreateKind;

interface SubjectsPageClientProps {
  initialSubjects: SubjectWithMetadata[];
  initialShelfItems: NotebookShelfItem[];
}

const typeLabels: Record<CreateKind, string> = {
  problem_set: '错题本',
  notebook: '空白笔记',
};

function formatUpdatedAt(value: string | null) {
  if (!value) return '暂无更新';

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '暂无更新';

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export default function SubjectsPageClient({
  initialSubjects,
  initialShelfItems,
}: SubjectsPageClientProps) {
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
      throw new Error('Failed to refresh notebook shelf');
    }
    const payload = await response.json();
    setItems(payload.data?.items || []);
    router.refresh();
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!createTitle.trim()) {
      toast.error('请输入名称');
      return;
    }
    if (!createSubjectId) {
      toast.error('请选择归档位置');
      return;
    }

    setCreateBusy(true);
    try {
      const endpoint =
        createKind === 'notebook' ? '/api/notebooks' : '/api/problem-sets';
      const body =
        createKind === 'notebook'
          ? {
              subject_id: createSubjectId,
              title: createTitle.trim(),
              description: createDescription.trim() || null,
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
        throw new Error(payload?.message || '创建失败');
      }

      setCreateOpen(false);
      setCreateTitle('');
      setCreateDescription('');
      toast.success(
        createKind === 'notebook' ? '空白笔记已创建' : '错题本已创建'
      );
      await refreshShelf();

      const createdId = payload?.data?.notebook?.id || payload?.data?.id;
      if (createdId) {
        router.push(
          createKind === 'notebook'
            ? `/notebooks/${createdId}`
            : `/problem-sets/${createdId}`
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建失败');
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
        throw new Error(payload?.message || '更新 AI 授权失败');
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
      toast.success(enabled ? '已授权 AI 写入' : '已取消 AI 授权');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新 AI 授权失败');
    } finally {
      setAccessBusyId(null);
    }
  }

  function openItem(item: NotebookShelfItem) {
    router.push(
      item.type === 'problem_set'
        ? `/problem-sets/${item.id}`
        : `/notebooks/${item.id}`
    );
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
          title="笔记本架"
          description="错题本和空白笔记都放在这里。归档只用于筛选和整理，不是进入内容前必须经过的层级。"
          actions={
            <Button onClick={() => openCreateDialog()}>
              <Plus className="mr-2 h-4 w-4" />
              新建
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
                placeholder="搜索错题本、空白笔记或归档"
                className="pl-10"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:w-[29rem]">
              <Select value={subjectFilter} onValueChange={setSubjectFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="筛选归档" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部归档</SelectItem>
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
                  <SelectValue placeholder="筛选类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  <SelectItem value="problem_set">错题本</SelectItem>
                  <SelectItem value="notebook">空白笔记</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <SlidersHorizontal className="h-4 w-4" />
              <span>当前显示 {filteredItems.length} 个</span>
              {hasFilters ? <Badge variant="outline">已筛选</Badge> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {hasFilters ? (
                <Button variant="ghost" size="sm" onClick={resetFilters}>
                  清除筛选
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed bg-muted/30 px-6 py-14 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border bg-background">
              <NotebookPen className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="mx-auto mt-4 max-w-md space-y-2">
              <h3 className="text-lg font-semibold">
                {items.length === 0 ? '笔记本架是空的' : '没有匹配内容'}
              </h3>
              <p className="text-sm text-muted-foreground">
                {items.length === 0
                  ? '先建立一个错题本收纳题目，或建立空白笔记记录普通内容。'
                  : '换一个关键词、归档或类型筛选，通常能更快找到目标内容。'}
              </p>
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {items.length === 0 ? null : (
                <Button variant="outline" onClick={resetFilters}>
                  清除筛选
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredItems.map(item => (
              <ShelfItemCard
                key={`${item.type}-${item.id}`}
                item={item}
                accessBusy={accessBusyId === item.id}
                onOpen={() => openItem(item)}
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
            <DialogTitle>新建本子</DialogTitle>
            <DialogDescription>
              选择本子类型并填写名称。细分整理留到题目和笔记内容里完成。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={createKind === 'problem_set' ? 'default' : 'outline'}
                onClick={() => setCreateKind('problem_set')}
              >
                <BookOpen className="mr-2 h-4 w-4" />
                错题本
              </Button>
              <Button
                type="button"
                variant={createKind === 'notebook' ? 'default' : 'outline'}
                onClick={() => setCreateKind('notebook')}
              >
                <FileText className="mr-2 h-4 w-4" />
                空白笔记
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-title">名称</Label>
              <Input
                id="notebook-title"
                value={createTitle}
                onChange={event => setCreateTitle(event.target.value)}
                maxLength={80}
                placeholder={
                  createKind === 'notebook' ? '课堂摘记' : '函数错题本'
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-subject">归档到</Label>
              <Select
                value={createSubjectId}
                onValueChange={setCreateSubjectId}
              >
                <SelectTrigger id="notebook-subject">
                  <SelectValue placeholder="选择归档位置" />
                </SelectTrigger>
                <SelectContent>
                  {subjects.map(subject => (
                    <SelectItem key={subject.id} value={subject.id}>
                      {subject.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {subjects.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  当前还没有可用归档，暂时无法创建本子。
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  仅用于筛选和整理，不会形成新的页面层级。
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="notebook-description">描述</Label>
              <Textarea
                id="notebook-description"
                value={createDescription}
                onChange={event => setCreateDescription(event.target.value)}
                maxLength={500}
                placeholder="可选"
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
              <Button
                type="submit"
                disabled={createBusy || subjects.length === 0}
              >
                {createBusy
                  ? '创建中...'
                  : createKind === 'problem_set'
                    ? '创建错题本'
                    : '创建空白笔记'}
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
  onOpen,
  onAiAccessChange,
}: {
  item: NotebookShelfItem;
  accessBusy: boolean;
  onOpen: () => void;
  onAiAccessChange: (checked: boolean) => void;
}) {
  const isProblemSet = item.type === 'problem_set';
  const isAiWritable = Boolean(item.ai_access?.can_create);

  return (
    <Card
      className={cn(
        'group cursor-pointer overflow-hidden rounded-lg border shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30',
        isProblemSet
          ? 'border-l-4 border-l-primary'
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
                  : 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
              )}
            >
              {isProblemSet ? (
                <BookOpen className="h-5 w-5" />
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
                <Badge variant="outline">{item.subject_name || '未分类'}</Badge>
              </div>
            </div>
          </div>
          {!isProblemSet && isAiWritable ? (
            <Badge
              variant="outline"
              className="shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              <CheckCircle2 className="mr-1 h-3 w-3" />
              AI 可写
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <p className="line-clamp-3 min-h-[3.75rem] text-sm leading-6 text-muted-foreground">
          {item.description ||
            (isProblemSet
              ? '用于保存和复习这一类错题，适合集中整理练习记录。'
              : '用于记录知识点、摘记和临时想法，不参与错题复习流程。')}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md bg-muted/60 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              {isProblemSet ? '题目数' : '笔记数'}
            </p>
            <p className="mt-1 font-semibold">{item.count}</p>
          </div>
          <div className="rounded-md bg-muted/60 px-3 py-2">
            <p className="text-xs text-muted-foreground">更新</p>
            <p className="mt-1 truncate font-medium">
              {formatUpdatedAt(item.updated_at)}
            </p>
          </div>
        </div>
      </CardContent>
      {!isProblemSet ? (
        <CardFooter
          className="justify-between gap-4 border-t bg-muted/20 px-5 py-4"
          onClick={event => event.stopPropagation()}
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">AI 写入授权</p>
            <p className="text-xs text-muted-foreground">
              {isAiWritable ? '已允许 AI 添加笔记' : '仅手动维护'}
            </p>
          </div>
          <Switch
            checked={isAiWritable}
            disabled={accessBusy}
            onCheckedChange={onAiAccessChange}
          />
        </CardFooter>
      ) : null}
    </Card>
  );
}

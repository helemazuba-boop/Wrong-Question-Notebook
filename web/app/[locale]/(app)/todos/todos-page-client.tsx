'use client';

import { useMemo, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import type { TodoListItem, TodoPriority, TodoStatus } from '@/lib/todos';
import type { SubjectWithMetadata } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  CalendarClock,
  Check,
  CheckCircle2,
  Circle,
  ListTodo,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

type StatusFilter = TodoStatus | 'all';

interface TodosPageClientProps {
  initialTodos: TodoListItem[];
  subjects: SubjectWithMetadata[];
}

const statusLabels: Record<StatusFilter, string> = {
  all: '全部',
  pending: '待办',
  completed: '已完成',
  cancelled: '已取消',
};

const priorityLabels: Record<TodoPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
};

function formatDateTime(value: string | null) {
  if (!value) return '未设定';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '未设定';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

function toDatetimeLocal(value: Date) {
  const offsetMs = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromDatetimeLocal(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export default function TodosPageClient({
  initialTodos,
  subjects,
}: TodosPageClientProps) {
  const [todos, setTodos] = useState(initialTodos);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('normal');
  const [subjectId, setSubjectId] = useState('none');
  const [dueAt, setDueAt] = useState('');
  const [reminderAt, setReminderAt] = useState('');

  const counts = useMemo(
    () => ({
      pending: todos.filter(todo => todo.status === 'pending').length,
      completed: todos.filter(todo => todo.status === 'completed').length,
      cancelled: todos.filter(todo => todo.status === 'cancelled').length,
    }),
    [todos]
  );

  const filteredTodos = useMemo(() => {
    return todos.filter(todo => {
      if (statusFilter !== 'all' && todo.status !== statusFilter) return false;
      if (subjectFilter !== 'all' && todo.subject_id !== subjectFilter) {
        return false;
      }
      return true;
    });
  }, [todos, statusFilter, subjectFilter]);

  async function refreshTodos(nextStatus = statusFilter) {
    const params = new URLSearchParams({
      status: nextStatus,
      limit: '100',
    });
    if (subjectFilter !== 'all') params.set('subject_id', subjectFilter);
    const response = await fetch(`/api/todos?${params.toString()}`, {
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || 'Todo 刷新失败');
    }
    setTodos(payload.data?.todos || []);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      toast.error('请输入 Todo 标题');
      return;
    }

    setCreateBusy(true);
    try {
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          priority,
          subject_id: subjectId === 'none' ? null : subjectId,
          due_at: fromDatetimeLocal(dueAt),
          reminder_at: fromDatetimeLocal(reminderAt),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Todo 创建失败');
      }

      const created = payload.data?.todo as TodoListItem | undefined;
      if (created) setTodos(current => [created, ...current]);
      setTitle('');
      setDescription('');
      setPriority('normal');
      setSubjectId('none');
      setDueAt('');
      setReminderAt('');
      setCreateOpen(false);
      toast.success('Todo 已创建');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Todo 创建失败');
    } finally {
      setCreateBusy(false);
    }
  }

  async function updateStatus(todoId: string, status: TodoStatus) {
    const endpoint =
      status === 'completed'
        ? `/api/todos/${todoId}/complete`
        : `/api/todos/${todoId}/cancel`;
    setBusy(todoId);
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Todo 更新失败');
      }
      const updated = payload.data?.todo as TodoListItem | undefined;
      if (updated) {
        setTodos(current =>
          current.map(todo => (todo.id === todoId ? updated : todo))
        );
      }
      toast.success(status === 'completed' ? '已完成' : '已取消');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Todo 更新失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Todo"
        description="顶层行动清单。用于安排今天要处理的学习动作，AI 可以创建和更新，但不会删除 Todo。"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                refreshTodos().catch(() => toast.error('刷新失败'))
              }
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              新建 Todo
            </Button>
          </>
        }
      />

      <div className="grid gap-3 md:grid-cols-3">
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              今日待办
              <Circle className="h-4 w-4 text-amber-600" />
            </CardTitle>
            <div className="text-3xl font-semibold">{counts.pending}</div>
          </CardHeader>
        </Card>
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              已完成
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            </CardTitle>
            <div className="text-3xl font-semibold">{counts.completed}</div>
          </CardHeader>
        </Card>
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              已取消
              <X className="h-4 w-4 text-muted-foreground" />
            </CardTitle>
            <div className="text-3xl font-semibold">{counts.cancelled}</div>
          </CardHeader>
        </Card>
      </div>

      <Card className="rounded-lg shadow-sm">
        <CardHeader className="gap-3 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2">
            {(
              ['pending', 'completed', 'cancelled', 'all'] as StatusFilter[]
            ).map(status => (
              <Button
                key={status}
                variant={statusFilter === status ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatusFilter(status)}
              >
                {statusLabels[status]}
              </Button>
            ))}
          </div>
          <Select value={subjectFilter} onValueChange={setSubjectFilter}>
            <SelectTrigger className="w-full md:w-48">
              <SelectValue placeholder="全部科目" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部科目</SelectItem>
              {subjects.map(subject => (
                <SelectItem key={subject.id} value={subject.id}>
                  {subject.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          {filteredTodos.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center">
              <ListTodo className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">没有符合条件的 Todo</p>
                <p className="text-sm text-muted-foreground">
                  新建一个行动项，或让 AI 帮你从对话中整理。
                </p>
              </div>
            </div>
          ) : (
            filteredTodos.map(todo => (
              <div
                key={todo.id}
                className={cn(
                  'flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between',
                  todo.status === 'completed' &&
                    'bg-green-50/60 dark:bg-green-950/10',
                  todo.status === 'cancelled' && 'opacity-70'
                )}
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{todo.title}</h2>
                    <Badge variant="outline">{statusLabels[todo.status]}</Badge>
                    <Badge variant="secondary">
                      {priorityLabels[todo.priority]}
                    </Badge>
                    {todo.subject_name ? (
                      <Badge variant="outline">{todo.subject_name}</Badge>
                    ) : null}
                  </div>
                  {todo.description ? (
                    <p className="text-sm text-muted-foreground">
                      {todo.description}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <CalendarClock className="h-3.5 w-3.5" />
                      截止 {formatDateTime(todo.due_at)}
                    </span>
                    {todo.reminder_at ? (
                      <span>提醒 {formatDateTime(todo.reminder_at)}</span>
                    ) : null}
                  </div>
                  {todo.word_entry_id || todo.word_deck_id ? (
                    <Link
                      className="text-sm text-primary hover:underline"
                      href={
                        todo.word_entry_id
                          ? `/words/progress?entry=${todo.word_entry_id}`
                          : `/words/decks/${todo.word_deck_id}`
                      }
                    >
                      查看 Word 进度
                    </Link>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {todo.status === 'pending' ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => updateStatus(todo.id, 'completed')}
                        disabled={busy === todo.id}
                      >
                        <Check className="mr-2 h-4 w-4" />
                        完成
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => updateStatus(todo.id, 'cancelled')}
                        disabled={busy === todo.id}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" disabled>
                      已归档
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 Todo</DialogTitle>
            <DialogDescription>
              Todo 用于安排要处理的学习动作，可以按科目归档。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="space-y-2">
              <Label htmlFor="todo-title">标题</Label>
              <Input
                id="todo-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                maxLength={120}
                placeholder="例如：复习导数链式法则"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="todo-description">说明</Label>
              <Textarea
                id="todo-description"
                value={description}
                onChange={event => setDescription(event.target.value)}
                maxLength={2000}
                placeholder="可选"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>科目</Label>
                <Select value={subjectId} onValueChange={setSubjectId}>
                  <SelectTrigger>
                    <SelectValue placeholder="不关联科目" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不关联科目</SelectItem>
                    {subjects.map(subject => (
                      <SelectItem key={subject.id} value={subject.id}>
                        {subject.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>优先级</Label>
                <Select
                  value={priority}
                  onValueChange={value => setPriority(value as TodoPriority)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">低</SelectItem>
                    <SelectItem value="normal">普通</SelectItem>
                    <SelectItem value="high">高</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="todo-due">截止时间</Label>
                <Input
                  id="todo-due"
                  type="datetime-local"
                  value={dueAt}
                  min={toDatetimeLocal(new Date())}
                  onChange={event => setDueAt(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="todo-reminder">提醒时间</Label>
                <Input
                  id="todo-reminder"
                  type="datetime-local"
                  value={reminderAt}
                  min={toDatetimeLocal(new Date())}
                  onChange={event => setReminderAt(event.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                关闭
              </Button>
              <Button type="submit" disabled={createBusy}>
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

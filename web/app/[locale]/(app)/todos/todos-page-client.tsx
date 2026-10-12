'use client';
import {
  useTranslations as useFeatureTranslations,
  useLocale as useFeatureLocale,
} from 'next-intl';

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
import { TodoReminderSettings } from '@/components/todo-reminder-settings';

type StatusFilter = TodoStatus | 'all';

interface TodosPageClientProps {
  initialTodos: TodoListItem[];
  subjects: SubjectWithMetadata[];
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
  const tFeature = useFeatureTranslations('Todos');
  const featureLocale = useFeatureLocale();
  const statusLabels: Record<StatusFilter, string> = {
    all: tFeature('all'),
    pending: tFeature('pending'),
    completed: tFeature('completed'),
    cancelled: tFeature('cancelled'),
  };
  const priorityLabels: Record<TodoPriority, string> = {
    low: tFeature('low'),
    normal: tFeature('normal'),
    high: tFeature('high'),
  };
  function formatDateTime(value: string | null) {
    if (!value) return tFeature('notSet');
    const time = Date.parse(value);
    if (Number.isNaN(time)) return tFeature('notSet');
    return new Intl.DateTimeFormat(featureLocale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(time));
  }

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
      throw new Error(payload?.error || tFeature('couldNotRefreshTodos'));
    }
    setTodos(payload.data?.todos || []);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      toast.error(tFeature('enterATodoTitle'));
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
        throw new Error(payload?.error || tFeature('couldNotCreateTheTodo2'));
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
      toast.success(tFeature('todoCreated'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotCreateTheTodo2')
      );
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
        throw new Error(payload?.error || tFeature('couldNotUpdateTheTodo'));
      }
      const updated = payload.data?.todo as TodoListItem | undefined;
      if (updated) {
        setTodos(current =>
          current.map(todo => (todo.id === todoId ? updated : todo))
        );
      }
      toast.success(
        status === 'completed' ? tFeature('completed') : tFeature('cancelled')
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tFeature('couldNotUpdateTheTodo')
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Todo"
        description={tFeature('planYourLearningActionsHereAiCan')}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                refreshTodos().catch(() =>
                  toast.error(tFeature('couldNotRefresh'))
                )
              }
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {tFeature('refresh')}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {tFeature('newTodo')}
            </Button>
          </>
        }
      />

      <div className="grid gap-3 md:grid-cols-3">
        <TodoReminderSettings />
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              {tFeature('todaySTodos')}
              <Circle className="h-4 w-4 text-amber-600" />
            </CardTitle>
            <div className="text-3xl font-semibold">{counts.pending}</div>
          </CardHeader>
        </Card>
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              {tFeature('completed')}
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            </CardTitle>
            <div className="text-3xl font-semibold">{counts.completed}</div>
          </CardHeader>
        </Card>
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardTitle className="flex items-center justify-between text-sm">
              {tFeature('cancelled')}
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
              <SelectValue placeholder={tFeature('allSubjects')} />
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
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          {filteredTodos.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center">
              <ListTodo className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">{tFeature('noMatchingTodos')}</p>
                <p className="text-sm text-muted-foreground">
                  {tFeature('createALearningActionOrAskAi')}
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
                      {tFeature('due3')}
                      {formatDateTime(todo.due_at)}
                    </span>
                    {todo.reminder_at ? (
                      <span>
                        {tFeature('reminder')}
                        {formatDateTime(todo.reminder_at)}
                      </span>
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
                      {tFeature('viewVocabularyProgress')}
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
                        {tFeature('complete')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => updateStatus(todo.id, 'cancelled')}
                        disabled={busy === todo.id}
                      >
                        {tFeature('cancel')}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" disabled>
                      {tFeature('archived')}
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
            <DialogTitle>{tFeature('newTodo')}</DialogTitle>
            <DialogDescription>
              {tFeature('todosOrganizeLearningActionsSubjectsAreOptional')}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="space-y-2">
              <Label htmlFor="todo-title">{tFeature('title')}</Label>
              <Input
                id="todo-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                maxLength={120}
                placeholder={tFeature(
                  'exampleReviewTheChainRuleForDerivatives'
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="todo-description">
                {tFeature('description2')}
              </Label>
              <Textarea
                id="todo-description"
                value={description}
                onChange={event => setDescription(event.target.value)}
                maxLength={2000}
                placeholder={tFeature('optional')}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{tFeature('subject')}</Label>
                <Select value={subjectId} onValueChange={setSubjectId}>
                  <SelectTrigger>
                    <SelectValue placeholder={tFeature('noSubject2')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {tFeature('noSubject2')}
                    </SelectItem>
                    {subjects.map(subject => (
                      <SelectItem key={subject.id} value={subject.id}>
                        {subject.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tFeature('priority')}</Label>
                <Select
                  value={priority}
                  onValueChange={value => setPriority(value as TodoPriority)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">{tFeature('low')}</SelectItem>
                    <SelectItem value="normal">{tFeature('normal')}</SelectItem>
                    <SelectItem value="high">{tFeature('high')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="todo-due">{tFeature('dueTime')}</Label>
                <Input
                  id="todo-due"
                  type="datetime-local"
                  value={dueAt}
                  min={toDatetimeLocal(new Date())}
                  onChange={event => setDueAt(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="todo-reminder">
                  {tFeature('reminderTime')}
                </Label>
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
                {tFeature('close')}
              </Button>
              <Button type="submit" disabled={createBusy}>
                {tFeature('create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

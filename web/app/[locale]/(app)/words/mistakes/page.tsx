import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { loadWrongWords } from '@/lib/words';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Word 错词' };
}

function formatDate(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export default async function WordMistakesPage() {
  const { user, supabase } = await requireUser();
  if (!user) redirect('/auth/login?redirect=/words/mistakes');
  const { mistakes } = await loadWrongWords(supabase, user.id, { limit: 50 });

  return (
    <div className="section-container space-y-6">
      <PageHeader
        title="Word 错词"
        description="在 Word 中确认“不认识”后会自动生成错题。这里保留词条入口，也可以直接进入错题复习。"
        actions={
          <Link className="text-sm text-primary hover:underline" href="/words">
            返回 Word
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>待巩固词条</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {mistakes.length === 0 ? (
            <div className="rounded-lg border border-dashed px-6 py-12 text-center">
              <p className="font-medium">还没有 Word 错题</p>
              <p className="mt-1 text-sm text-muted-foreground">
                学习时确认“不认识”的词会自动出现在这里。
              </p>
            </div>
          ) : (
            mistakes.map(item => (
              <div
                key={item.problem_id}
                className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{item.word.word}</p>
                    <Badge variant="destructive">错题</Badge>
                    <Badge variant="outline">
                      {item.word.status || 'learning'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.word.meaning}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    最近进入错题：{formatDate(item.updated_at)}
                  </p>
                </div>
                <Link
                  className="text-sm text-primary hover:underline"
                  href={`/problem-sets/${item.problem_set_id}/review?problemId=${item.problem_id}`}
                >
                  进入错题复习
                </Link>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

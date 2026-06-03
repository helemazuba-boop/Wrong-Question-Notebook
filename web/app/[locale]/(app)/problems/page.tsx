import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';
import { Link } from '@/i18n/navigation';

export default async function ProblemsChooser() {
  const supabase = await createClient();
  const { data: subjects } = await supabase
    .from('subjects')
    .select('*')
    .order('created_at', { ascending: true });

  return (
    <div className="section-container">
      <PageHeader
        title="题目"
        description="选择一个笔记本进入题目列表。"
      />

      <Card className="card-section">
        <CardContent className="card-section-content pt-6">
          <ul className="space-y-2">
            {(subjects ?? []).map((s: any) => (
              <li key={s.id}>
                <Link
                  className="text-primary underline hover:text-primary/80 transition-colors"
                  href={`/subjects/${s.id}/problems`}
                >
                  {s.name}
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-6 border-t pt-4">
            <p className="text-body-sm text-muted-foreground">
              提示：如需新建分类，请先进入{' '}
              <Link
                href="/subjects"
                className="underline text-primary hover:text-primary/80 transition-colors"
              >
                笔记本架
              </Link>{' '}
              。
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

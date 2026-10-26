import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { readProblemSemantics } from '@/lib/problem-marks/read';
import { wakeProblemMarkAnnotation } from '@/lib/problem-marks/wake';
import { consumeRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, { params }: Context) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return NextResponse.json({ error: 'Invalid problem id' }, { status: 400 });
  try {
    return NextResponse.json({
      data: await readProblemSemantics(supabase, id),
    });
  } catch {
    return NextResponse.json(
      { error: 'Problem marks unavailable' },
      { status: 404 }
    );
  }
}
export async function POST(_req: Request, { params }: Context) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return NextResponse.json({ error: 'Invalid problem id' }, { status: 400 });
  const { data, error } = await supabase
    .from('problems')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error)
    return NextResponse.json({ error: 'Problem unavailable' }, { status: 503 });
  if (!data)
    return NextResponse.json({ error: 'Problem not found' }, { status: 404 });
  const limit = consumeRateLimit('problem-mark-retry', user.id, {
    windowMs: 60000,
    maxRequests: 3,
  });
  if (!limit.ok)
    return NextResponse.json(
      { error: 'Retry rate limited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
    );
  const result = await createServiceClient().rpc(
    'requeue_problem_mark_annotation',
    { p_problem_id: id }
  );
  if (result.error)
    return NextResponse.json(
      { error: 'Classification is not retryable' },
      { status: 409 }
    );
  wakeProblemMarkAnnotation(id);
  return NextResponse.json({ data: { status: 'pending' } }, { status: 202 });
}

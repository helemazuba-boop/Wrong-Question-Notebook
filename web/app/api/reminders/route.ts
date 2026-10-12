import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
async function list(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const offset = Number(new URL(req.url).searchParams.get('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
    return NextResponse.json({ error: 'Invalid page' }, { status: 400 });
  const { data, error } = await (supabase as any)
    .from('todo_notifications')
    .select('id,title,todo_id,reminder_at,read_at,todo_push_deliveries(status)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .order('id')
    .range(offset, offset + 49);
  return error
    ? NextResponse.json({ error: 'Reminders unavailable' }, { status: 503 })
    : NextResponse.json({ notifications: data ?? [] });
}
async function read(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const body = await req.json().catch(() => null);
  if (typeof body?.id !== 'string')
    return NextResponse.json({ error: 'Invalid reminder' }, { status: 400 });
  const { error } = await (supabase as any)
    .from('todo_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', body.id)
    .eq('user_id', user.id);
  return error
    ? NextResponse.json({ error: 'Reminder update failed' }, { status: 503 })
    : NextResponse.json({ ok: true });
}
export const GET = withSecurity(list, { rateLimitType: 'readOnly' });
export const PATCH = withSecurity(read, { rateLimitType: 'api' });

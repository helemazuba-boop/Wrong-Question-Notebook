import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
export async function GET() {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  const db = createServiceClient() as any;
  const { data: actions, error: actionError } = await db
    .from('mcp_v2_user_actions')
    .select('operation_id')
    .eq('user_id', user.id)
    .eq('state', 'pending')
    .limit(1000);
  if (actionError)
    return NextResponse.json(
      { error: 'Operations unavailable' },
      { status: 503 }
    );
  const ids = [
    ...new Set(
      (actions ?? []).map((a: { operation_id: string }) => a.operation_id)
    ),
  ];
  let query = db
    .from('mcp_v2_operations')
    .select('id,state,resource_type,created_at')
    .eq('user_id', user.id);
  query = ids.length
    ? query.or(`state.eq.awaiting_approval,id.in.(${ids.join(',')})`)
    : query.eq('state', 'awaiting_approval');
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(100);
  if (error)
    return NextResponse.json(
      { error: 'Operations unavailable' },
      { status: 503 }
    );
  return NextResponse.json(
    { data },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

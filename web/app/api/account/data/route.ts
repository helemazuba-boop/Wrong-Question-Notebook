import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { createClient } from '@/lib/supabase/server';
import { recentlyAuthenticated } from '@/lib/account-data';
import { withSecurity } from '@/lib/security-middleware';
import { z } from 'zod';
async function enqueue(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const { data, error } = await supabase.auth.getClaims();
  if (
    error ||
    data?.claims?.sub !== user.id ||
    !recentlyAuthenticated(data.claims)
  )
    return NextResponse.json(
      { error: 'reauthentication_required' },
      { status: 403 }
    );
  const parsed = z
    .object({ kind: z.enum(['export', 'delete']), confirm: z.literal(true) })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Invalid account operation' },
      { status: 400 }
    );
  const result = await (createServiceClient() as any).rpc(
    'enqueue_account_data_job',
    { p_user_id: user.id, p_actor_id: user.id, p_kind: parsed.data.kind }
  );
  if (result.error)
    return NextResponse.json(
      {
        error:
          result.error.code === '42501'
            ? 'account_operation_forbidden'
            : 'Account operation unavailable',
      },
      {
        status:
          result.error.code === '42501'
            ? 403
            : result.error.code === '40001'
              ? 409
              : 503,
      }
    );
  return NextResponse.json({ id: result.data }, { status: 202 });
}
async function status(req: Request) {
  // The pending-deletion account is disabled. A verified old JWT can ONLY
  // read its own job progress through this endpoint, not use business APIs.
  const client = await createClient();
  const { data, error } = await client.auth.getClaims();
  if (error || typeof data?.claims?.sub !== 'string') return unauthorised();
  const offset = Number(new URL(req.url).searchParams.get('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    return NextResponse.json({ error: 'Invalid page' }, { status: 400 });
  const result = await (createServiceClient() as any)
    .from('account_data_jobs')
    .select('id,kind,status,created_at,completed_at,expires_at,last_error')
    .eq('user_id', data.claims.sub)
    .order('created_at', { ascending: false })
    .order('id')
    .range(offset, offset + 49);
  return result.error
    ? NextResponse.json(
        { error: 'Account operation status unavailable' },
        { status: 503 }
      )
    : NextResponse.json({ jobs: result.data ?? [] });
}
export const GET = withSecurity(status, { rateLimitType: 'readOnly' });
export const POST = withSecurity(enqueue, { rateLimitType: 'api' });

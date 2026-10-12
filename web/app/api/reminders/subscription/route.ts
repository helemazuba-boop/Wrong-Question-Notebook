import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { PushSubscriptionBody, pushConfiguration } from '@/lib/todo-reminders';
import { withSecurity } from '@/lib/security-middleware';
async function configuration() {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  const config = pushConfiguration();
  return NextResponse.json({ publicKey: config?.publicKey ?? null });
}
async function subscribe(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  if (!pushConfiguration())
    return NextResponse.json(
      { error: 'Push notifications are not configured' },
      { status: 503 }
    );
  const parsed = PushSubscriptionBody.safeParse(
    await req.json().catch(() => null)
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Invalid subscription' },
      { status: 400 }
    );
  const client = createServiceClient();
  const { error } = await (client as any).rpc('register_push_subscription', {
    p_user_id: user.id,
    p_endpoint: parsed.data.endpoint,
    p_p256dh: parsed.data.keys.p256dh,
    p_auth: parsed.data.keys.auth,
    p_locale: parsed.data.locale,
  });
  if (error?.code === '42501')
    return NextResponse.json(
      { error: 'Subscription ownership conflict' },
      { status: 409 }
    );
  return error
    ? NextResponse.json({ error: 'Subscription save failed' }, { status: 503 })
    : NextResponse.json({ ok: true });
}
async function unsubscribe(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  const body = await req.json().catch(() => null);
  if (typeof body?.endpoint !== 'string')
    return NextResponse.json(
      { error: 'Invalid subscription' },
      { status: 400 }
    );
  const { error } = await (createServiceClient() as any)
    .from('push_subscriptions')
    .delete()
    .eq('user_id', user.id)
    .eq('endpoint', body.endpoint);
  return error
    ? NextResponse.json(
        { error: 'Subscription removal failed' },
        { status: 503 }
      )
    : NextResponse.json({ ok: true });
}
export const GET = withSecurity(configuration, { rateLimitType: 'readOnly' });
export const POST = withSecurity(subscribe, { rateLimitType: 'api' });
export const DELETE = withSecurity(unsubscribe, { rateLimitType: 'api' });

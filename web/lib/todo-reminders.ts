import 'server-only';
import webpush from 'web-push';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accountIsActive } from '@/lib/supabase/account-status';

const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'wns.windows.com',
];
export function isBrowserPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      PUSH_HOSTS.some(
        host =>
          url.hostname === host ||
          (host !== 'fcm.googleapis.com' && url.hostname.endsWith(`.${host}`))
      )
    );
  } catch {
    return false;
  }
}
export const PushSubscriptionBody = z
  .object({
    endpoint: z.string().max(4096).refine(isBrowserPushEndpoint),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87,88}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22,24}$/),
      })
      .strict(),
    locale: z.enum(['en', 'zh-CN']).default('zh-CN'),
  })
  .strict();
export function pushConfiguration() {
  const {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  } = process.env;
  return publicKey && privateKey && subject
    ? { publicKey, privateKey, subject }
    : null;
}
export async function processTodoReminders(
  client: SupabaseClient<any>,
  send = webpush.sendNotification
) {
  const { data: enqueued, error: enqueueError } = await client.rpc(
    'enqueue_todo_reminders'
  );
  if (enqueueError) throw new Error('Reminder enqueue failed');
  const config = pushConfiguration();
  if (!config) return { enqueued, sent: 0, pushConfigured: false };
  const { data: deliveries, error: claimError } = await client.rpc(
    'claim_todo_push_deliveries',
    { p_limit: 4 }
  );
  if (claimError) throw new Error('Reminder claim failed');
  let sent = 0;
  for (const delivery of deliveries ?? []) {
    let patch: Record<string, unknown>;
    try {
      const { data: notification, error: notificationError } = await client
        .from('todo_notifications')
        .select('id,user_id,todo_id,reminder_at,title')
        .eq('id', delivery.notification_id)
        .single();
      if (notificationError) throw new Error('Reminder read failed');
      const { data: todo, error: todoError } = await client
        .from('todos')
        .select('status,reminder_at,title')
        .eq('id', notification.todo_id)
        .eq('user_id', notification.user_id)
        .maybeSingle();
      if (todoError) throw new Error('Todo read failed');
      if (
        !todo ||
        todo.status !== 'pending' ||
        Date.parse(todo.reminder_at) !== Date.parse(notification.reminder_at) ||
        !(await accountIsActive(client, notification.user_id))
      ) {
        patch = { status: 'cancelled', last_error: null };
      } else {
        const { data: subscription, error: subscriptionError } = await client
          .from('push_subscriptions')
          .select('*')
          .eq('id', delivery.subscription_id)
          .eq('user_id', notification.user_id)
          .single();
        if (subscriptionError) throw new Error('Subscription read failed');
        if (!isBrowserPushEndpoint(subscription.endpoint))
          throw new Error('Invalid push endpoint');
        await send(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({
            id: notification.id,
            title: subscription.locale === 'en' ? 'Todo reminder' : '待办提醒',
            body: todo.title,
          }),
          {
            vapidDetails: config,
            TTL: 300,
            timeout: 10000,
            topic: notification.id.replaceAll('-', ''),
          }
        );
        patch = {
          status: 'sent',
          sent_at: new Date().toISOString(),
          last_error: null,
        };
        sent++;
      }
    } catch (error) {
      const code = (error as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        const result = await client
          .from('push_subscriptions')
          .delete()
          .eq('id', delivery.subscription_id);
        if (result.error)
          throw new Error('Expired subscription cleanup failed');
        continue;
      }
      patch = {
        status: delivery.attempts >= 6 ? 'failed' : 'pending',
        last_error: code ? `push_http_${code}` : 'delivery_unavailable',
        next_attempt_at: new Date(
          Date.now() + Math.min(3600000, 60000 * 2 ** delivery.attempts)
        ).toISOString(),
      };
    }
    const { error } = await client
      .from('todo_push_deliveries')
      .update({ ...patch, lease_until: null })
      .eq('id', delivery.id)
      .eq('lease_id', delivery.lease_id)
      .eq('status', 'sending');
    if (error) throw new Error('Reminder result persistence failed');
  }
  return { enqueued, sent, pushConfigured: true };
}

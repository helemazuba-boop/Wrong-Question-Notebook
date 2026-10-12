import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult } from '@/lib/test/supabase-query';
vi.mock('server-only', () => ({}));
import {
  isBrowserPushEndpoint,
  processTodoReminders,
  PushSubscriptionBody,
} from '@/lib/todo-reminders';
const delivery = {
  id: 'delivery',
  notification_id: 'reminder',
  subscription_id: 'subscription',
  lease_id: 'lease',
  attempts: 1,
};
function fixture(status = 'pending', active = true) {
  const update = vi.fn(() => queryResult([])),
    remove = vi.fn(() => queryResult([]));
  const from = vi.fn((table: string) => {
    if (table === 'todo_push_deliveries') return { update };
    if (table === 'user_profiles') return queryResult({ is_active: active });
    if (table === 'todo_notifications')
      return queryResult({
        id: 'reminder',
        user_id: 'user',
        todo_id: 'todo',
        reminder_at: '2026-10-12T00:00:00Z',
      });
    if (table === 'todos')
      return queryResult({
        status,
        reminder_at: '2026-10-12T00:00:00Z',
        title: 'Study',
      });
    return {
      ...queryResult({
        endpoint: 'https://fcm.googleapis.com/token',
        p256dh: 'key',
        auth: 'auth',
        locale: 'en',
      }),
      delete: remove,
    };
  });
  const rpc = vi.fn((name: string) =>
    Promise.resolve({
      data: name === 'enqueue_todo_reminders' ? 1 : [delivery],
      error: null,
    })
  );
  return { client: { from, rpc } as any, update, remove, rpc, from };
}
beforeEach(() => {
  vi.stubEnv('VAPID_PUBLIC_KEY', 'public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'private');
  vi.stubEnv('VAPID_SUBJECT', 'mailto:admin@example.invalid');
});
describe('todo reminders', () => {
  it('rejects arbitrary destinations including private-network SSRF endpoints', () => {
    for (const url of [
      'http://fcm.googleapis.com/a',
      'https://127.0.0.1/a',
      'https://fcm.googleapis.com.evil.test/a',
      'https://user@fcm.googleapis.com/a',
      'https://fcm.googleapis.com:8443/a',
    ])
      expect(isBrowserPushEndpoint(url)).toBe(false);
    expect(isBrowserPushEndpoint('https://fcm.googleapis.com/token')).toBe(
      true
    );
    expect(
      PushSubscriptionBody.safeParse({
        endpoint: 'https://localhost',
        keys: { p256dh: 'x', auth: 'x' },
      }).success
    ).toBe(false);
  });
  it('delivers into the inbox even when browser push is not configured', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    const f = fixture(),
      send = vi.fn();
    expect(await processTodoReminders(f.client, send)).toEqual({
      enqueued: 1,
      sent: 0,
      pushConfigured: false,
    });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    ['completed', true],
    ['cancelled', true],
    ['pending', false],
  ])('does not send after status %s / active %s', async (status, active) => {
    const f = fixture(status, active),
      send = vi.fn();
    await processTodoReminders(f.client, send);
    expect(send).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' })
    );
  });
  it('uses a stable notification identifier and persists provider acceptance', async () => {
    const f = fixture(),
      send = vi.fn().mockResolvedValue({});
    await processTodoReminders(f.client, send);
    expect(JSON.parse(send.mock.calls[0][1]).id).toBe('reminder');
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent' })
    );
  });
  it('keeps temporary failures for a later tick and removes expired endpoints', async () => {
    const f = fixture(),
      send = vi.fn().mockRejectedValue({ statusCode: 503 });
    await processTodoReminders(f.client, send);
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        last_error: 'push_http_503',
      })
    );
    const expired = fixture();
    await processTodoReminders(
      expired.client,
      vi.fn().mockRejectedValue({ statusCode: 410 })
    );
    expect(expired.remove).toHaveBeenCalled();
  });
  it('stops on enqueue/claim faults instead of reporting false delivery success', async () => {
    const f = fixture();
    f.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'offline' },
    } as any);
    await expect(processTodoReminders(f.client, vi.fn())).rejects.toThrow(
      'enqueue'
    );
  });
});

'use client';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

type Reminder = {
  id: string;
  title: string;
  reminder_at: string;
  read_at: string | null;
  todo_push_deliveries?: Array<{ status: string }>;
};
export function TodoReminderSettings() {
  const t = useTranslations('Todos');
  const locale = useLocale();
  const [supported, setSupported] = useState(false),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const [notifications, setNotifications] = useState<Reminder[]>([]),
    [offset, setOffset] = useState(0);
  async function load(nextOffset = offset) {
    try {
      const response = await fetch(`/api/reminders?offset=${nextOffset}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      setNotifications((await response.json()).notifications);
      setOffset(nextOffset);
      setError(false);
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    setSupported(
      'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
    void load(0);
    void navigator.serviceWorker
      ?.getRegistration('/')
      .then(async registration =>
        setEnabled(!!(await registration?.pushManager.getSubscription()))
      );
    // Polling also provides the inbox delivery channel in Android WebView.
    const timer = setInterval(() => void load(0), 60000);
    return () => clearInterval(timer);
    // Only initial mount owns polling; pagination uses explicit loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function toggle() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.register(
        '/reminder-sw.js',
        { scope: '/' }
      );
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (enabled && subscription) {
        const response = await fetch('/api/reminders/subscription', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error();
        await subscription.unsubscribe();
        setEnabled(false);
        return;
      }
      const response = await fetch('/api/reminders/subscription');
      if (!response.ok) throw new Error();
      const { publicKey } = await response.json();
      if (!publicKey) {
        toast.error(t('pushNotConfigured'));
        return;
      }
      if ((await Notification.requestPermission()) !== 'granted') {
        toast.error(t('permissionDenied'));
        return;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
      const json = subscription.toJSON();
      const saved = await fetch('/api/reminders/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          locale,
        }),
      });
      if (!saved.ok) {
        await subscription.unsubscribe();
        throw new Error();
      }
      setEnabled(true);
    } catch {
      toast.error(t('reminderUnavailable'));
    } finally {
      setBusy(false);
    }
  }
  async function markRead(id: string) {
    const response = await fetch('/api/reminders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) {
      toast.error(t('reminderUnavailable'));
      return;
    }
    await load();
  }
  return (
    <section className="rounded-xl border p-4 space-y-3">
      <h2 className="font-semibold">{t('reminderSettings')}</h2>
      <p className="text-sm text-muted-foreground">
        {supported ? t('pushDescription') : t('inboxOnly')}
      </p>
      {supported && (
        <Button variant="outline" disabled={busy} onClick={toggle}>
          {enabled ? t('disablePush') : t('enablePush')}
        </Button>
      )}
      <h3>{t('reminderInbox')}</h3>
      {error ? (
        <p role="alert">
          {t('reminderUnavailable')}{' '}
          <Button onClick={() => load()}>{t('retry')}</Button>
        </p>
      ) : notifications.length === 0 ? (
        <p>{t('noReminders')}</p>
      ) : (
        notifications.map(reminder => (
          <div
            key={reminder.id}
            className="flex items-center justify-between gap-3"
          >
            <span>
              {reminder.title}
              {reminder.todo_push_deliveries?.length ? (
                <small className="block text-muted-foreground">
                  {t(
                    reminder.todo_push_deliveries.some(
                      d => d.status === 'failed'
                    )
                      ? 'pushFailed'
                      : reminder.todo_push_deliveries.some(
                            d => d.status === 'sent'
                          )
                        ? 'pushAccepted'
                        : reminder.todo_push_deliveries.every(
                              d => d.status === 'cancelled'
                            )
                          ? 'pushCancelled'
                          : 'pushPending'
                  )}
                </small>
              ) : null}
            </span>
            {!reminder.read_at && (
              <Button variant="ghost" onClick={() => markRead(reminder.id)}>
                {t('markRead')}
              </Button>
            )}
          </div>
        ))
      )}
      <nav className="flex gap-3">
        {offset > 0 && (
          <Button onClick={() => load(Math.max(0, offset - 50))}>
            {t('previous')}
          </Button>
        )}
        {notifications.length === 50 && (
          <Button onClick={() => load(offset + 50)}>{t('next')}</Button>
        )}
      </nav>
    </section>
  );
}

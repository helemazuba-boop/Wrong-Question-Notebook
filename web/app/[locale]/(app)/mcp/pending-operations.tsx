'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
export default function PendingOperations() {
  const t = useTranslations('McpOperation');
  const [items, setItems] = useState<
    Array<{ id: string; state: string; created_at: string }>
  >([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/mcp/operations', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async r => {
        if (!r.ok) throw new Error();
        setItems((await r.json()).data);
      })
      .catch(e => {
        if (e.name !== 'AbortError') setFailed(true);
      });
    return () => controller.abort();
  }, []);
  return (
    <section className="landing-card my-4 space-y-3">
      <h2 className="font-semibold">{t('pendingTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('v2Hint')}</p>
      {failed ? (
        <p>{t('loadFailed')}</p>
      ) : items.length ? (
        <ul className="space-y-2">
          {items.map(item => (
            <li key={item.id}>
              <Link className="underline" href={`/mcp/operations/${item.id}`}>
                {item.state === 'awaiting_approval'
                  ? t('reviewPending')
                  : t('completePending')}
              </Link>{' '}
              <time
                className="text-sm text-muted-foreground"
                dateTime={item.created_at}
              >
                {new Date(item.created_at).toLocaleDateString()}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('nonePending')}</p>
      )}
    </section>
  );
}

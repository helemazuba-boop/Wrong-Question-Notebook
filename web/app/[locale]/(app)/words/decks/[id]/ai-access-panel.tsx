'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export default function AiAccessPanel({
  deckId,
  system,
  initial,
}: {
  deckId: string;
  system: boolean;
  initial?: { can_read: boolean; can_create: boolean };
}) {
  const t = useTranslations('McpOperation');
  const [read, setRead] = useState(initial?.can_read ?? false),
    [create, setCreate] = useState(initial?.can_create ?? false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/words/decks/${deckId}/ai-access`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          can_read: read,
          can_create: system ? false : create,
        }),
      });
      if (!response.ok) throw new Error(t('saveFailed'));
      setMessage(t('accessSaved'));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="landing-card space-y-3">
      <h2 className="font-semibold">{t('wordAccess')}</h2>
      <p className="text-sm text-muted-foreground">{t('wordAccessHint')}</p>
      <label className="block">
        <input
          type="checkbox"
          checked={read}
          disabled={busy}
          onChange={e => setRead(e.target.checked)}
        />{' '}
        {t('allowRead')}
      </label>
      {!system && (
        <label className="block">
          <input
            type="checkbox"
            checked={create}
            disabled={busy}
            onChange={e => setCreate(e.target.checked)}
          />{' '}
          {t('allowCreate')}
        </label>
      )}
      <Button disabled={busy} onClick={() => void save()}>
        {t('saveAccess')}
      </Button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

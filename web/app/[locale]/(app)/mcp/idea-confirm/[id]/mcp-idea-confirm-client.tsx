'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface ChallengePreview {
  challenge_id: string;
  problem_id: string;
  problem_title: string;
  exact_text: string;
  exact_text_hash: string;
  expires_at: string;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: ChallengePreview }
  | { status: 'confirming'; preview: ChallengePreview }
  | { status: 'confirmed'; preview: ChallengePreview }
  | { status: 'error'; message: string };

function fragmentToken(): string {
  const fragment = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(fragment).get('token') ?? '';
}

export default function McpIdeaConfirmClient({
  challengeId,
}: {
  challengeId: string;
}) {
  const t = useTranslations('McpIdeaConfirm');
  const [token, setToken] = useState('');
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  useEffect(() => {
    const challengeToken = fragmentToken();
    setToken(challengeToken);
    if (!challengeToken) {
      setState({ status: 'error', message: t('invalidLink') });
      return;
    }

    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/mcp/idea-confirm/${challengeId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: challengeToken }),
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok || !body.data) {
          setState({
            status: 'error',
            message: body.error || t('invalidLink'),
          });
          return;
        }
        setState({ status: 'ready', preview: body.data });
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setState({ status: 'error', message: t('loadFailed') });
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [challengeId, t]);

  const confirm = async () => {
    if (state.status !== 'ready') return;
    const preview = state.preview;
    setState({ status: 'confirming', preview });
    try {
      const response = await fetch(`/api/mcp/idea-confirm/${challengeId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await response.json();
      if (!response.ok || !body.data) {
        setState({ status: 'error', message: body.error || t('saveFailed') });
        return;
      }
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
      setState({ status: 'confirmed', preview });
    } catch {
      setState({ status: 'error', message: t('saveFailed') });
    }
  };

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
        <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <p>{state.message}</p>
      </div>
    );
  }

  const preview = state.preview;
  if (state.status === 'confirmed') {
    return (
      <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
        <div className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-5 w-5" />
          {t('confirmedTitle')}
        </div>
        <p className="text-sm">{t('confirmedDescription')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="text-sm">{t('authorityNotice')}</p>
      </div>

      <div>
        <p className="text-sm font-medium text-muted-foreground">
          {t('problemLabel')}
        </p>
        <p className="mt-1 font-semibold">{preview.problem_title}</p>
      </div>

      <div>
        <p className="text-sm font-medium text-muted-foreground">
          {t('exactTextLabel')}
        </p>
        <blockquote className="mt-2 whitespace-pre-wrap rounded-xl border bg-muted/40 p-4 text-sm leading-6">
          {preview.exact_text}
        </blockquote>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('expiresAt', {
          date: new Date(preview.expires_at).toLocaleString(),
        })}
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          onClick={() => window.close()}
          disabled={state.status === 'confirming'}
        >
          {t('reject')}
        </Button>
        <Button onClick={confirm} disabled={state.status === 'confirming'}>
          {state.status === 'confirming' ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {t('confirmExactText')}
        </Button>
      </div>
    </div>
  );
}

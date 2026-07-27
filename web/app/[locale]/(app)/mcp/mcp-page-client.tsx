'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/page-header';

type McpToken = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

export default function McpPageClient() {
  const t = useTranslations('Mcp');
  const tCommon = useTranslations('Common');

  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdPlaintext, setCreatedPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const endpointUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/mcp` : '';

  const loadTokens = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mcp-tokens');
      const json = await res.json();
      if (json.success) {
        setTokens(json.data.tokens || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const handleCreate = async () => {
    if (!tokenName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tokenName.trim() }),
      });
      const json = await res.json();
      if (json.success) {
        setCreatedPlaintext(json.data.plaintext);
        setTokenName('');
        loadTokens();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (non-HTTPS context); the token stays visible.
    }
  };

  const handleRevoke = async (tokenId: string) => {
    setRevokingId(tokenId);
    try {
      const res = await fetch(`/api/mcp-tokens/${tokenId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setTokens(prev => prev.filter(token => token.id !== tokenId));
      }
    } finally {
      setRevokingId(null);
    }
  };

  const closeCreateDialog = (open: boolean) => {
    setCreateOpen(open);
    if (!open) {
      setCreatedPlaintext(null);
      setTokenName('');
    }
  };

  const clientConfig = JSON.stringify(
    {
      mcpServers: {
        wqn: {
          url: endpointUrl || 'https://<your-wqn-host>/api/mcp',
          headers: { Authorization: 'Bearer <your-token>' },
        },
      },
    },
    null,
    2
  );

  return (
    <div className="section-container">
      <PageHeader
        title={t('title')}
        description={t('pageSubtitle')}
        actions={
          <Button
            onClick={() => setCreateOpen(true)}
            className="btn-cta-primary py-2.5"
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('createToken')}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <section className="landing-card border-emerald-200/40 from-emerald-50 to-teal-100/50 dark:border-emerald-800/30 dark:from-emerald-950/40 dark:to-teal-900/20">
          <div className="flex items-center gap-3">
            <div className="landing-icon-box bg-emerald-500/10 dark:bg-emerald-500/20">
              <KeyRound className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h2 className="landing-card-title">{t('tokens')}</h2>
              <p className="landing-card-text">{t('tokensHint')}</p>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200/40 bg-white/70 px-4 py-5 text-sm text-muted-foreground dark:border-emerald-800/30 dark:bg-gray-900/40">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tCommon('loading')}
            </div>
          ) : tokens.length === 0 ? (
            <div className="rounded-xl border border-dashed border-emerald-300/60 bg-white/70 px-4 py-8 text-center dark:border-emerald-800/40 dark:bg-gray-900/40">
              <p className="font-medium text-gray-900 dark:text-white">
                {t('noTokensTitle')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('noTokensDesc')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {tokens.map(token => (
                <div
                  key={token.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200/40 bg-white/70 px-4 py-3 dark:border-emerald-800/30 dark:bg-gray-900/40"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900 dark:text-white">
                      {token.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('createdAt', {
                        date: new Date(token.created_at).toLocaleDateString(),
                      })}
                      {' · '}
                      {token.last_used_at
                        ? t('lastUsedAt', {
                            date: new Date(token.last_used_at).toLocaleString(),
                          })
                        : t('neverUsed')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 rounded-xl text-red-600 hover:text-red-700 dark:text-red-400"
                    disabled={revokingId === token.id}
                    onClick={() => handleRevoke(token.id)}
                  >
                    {revokingId === token.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    <span className="ml-1">{t('revoke')}</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="landing-card border-blue-200/40 from-blue-50 to-blue-100/50 dark:border-blue-800/30 dark:from-blue-950/40 dark:to-blue-900/20">
          <div className="landing-icon-box bg-blue-500/10 dark:bg-blue-500/20">
            <Plug className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="space-y-2">
            <h2 className="landing-card-title">{t('connectTitle')}</h2>
            <p className="landing-card-text">{t('connectExplanation')}</p>
            <p className="text-xs font-medium text-muted-foreground">
              {t('endpointLabel')}
            </p>
            <p className="break-all font-mono text-sm text-blue-700 dark:text-blue-300">
              {endpointUrl || '…/api/mcp'}
            </p>
            <p className="text-xs font-medium text-muted-foreground">
              {t('configExampleLabel')}
            </p>
            <pre className="overflow-x-auto rounded-lg bg-gray-900/90 p-3 text-xs text-gray-100">
              {clientConfig}
            </pre>
          </div>
        </aside>
      </div>

      <Dialog open={createOpen} onOpenChange={closeCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createToken')}</DialogTitle>
            <DialogDescription>
              {createdPlaintext ? t('plaintextWarning') : t('createTokenHint')}
            </DialogDescription>
          </DialogHeader>

          {createdPlaintext ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
                <code className="min-w-0 flex-1 break-all font-mono text-sm">
                  {createdPlaintext}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => handleCopy(createdPlaintext)}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <DialogFooter>
                <Button onClick={() => closeCreateDialog(false)}>
                  {t('done')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <Input
                value={tokenName}
                onChange={event => setTokenName(event.target.value)}
                placeholder={t('tokenNamePlaceholder')}
                maxLength={60}
              />
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => closeCreateDialog(false)}
                >
                  {tCommon('cancel')}
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={creating || !tokenName.trim()}
                >
                  {creating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {tCommon('create')}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

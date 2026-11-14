'use client';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { uploadFiles } from '@/lib/storage/client';
import { RichTextDisplay } from '@/components/ui/rich-text-display';
import Image from 'next/image';
import { apiGet, apiPost, apiPut, isApiError } from '@/lib/api-client';
import { localizedApiErrorMessage } from '@/lib/error-codes';
import type { TranslatorProp } from '@/i18n/types';

const ERROR_KEYS = {
  origin_mismatch: 'originMismatch',
  review_refresh_required: 'reviewRefreshRequired',
  operation_unavailable: 'operationUnavailable',
} as const;

interface Preview {
  operation_id: string;
  tool_name: string;
  state: string;
  resource_type: string | null;
  resource_id: string | null;
  nonce: string;
  before: Record<string, unknown> | null;
  changes: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  revision_changed: boolean;
  actions: Array<{
    id: string;
    kind: string;
    state: string;
    idea: string | null;
  }>;
  images: Array<{ path: string; role: string; url: string | null }>;
}
const format = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
function Value({
  field,
  value,
  rich,
}: {
  field: string;
  value: unknown;
  rich?: boolean;
}) {
  if (
    rich &&
    ['content', 'solution_text'].includes(field) &&
    typeof value === 'string'
  )
    return <RichTextDisplay className="rounded border p-3" content={value} />;
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border p-3">
      {format(value)}
    </pre>
  );
}
export default function OperationClient({
  operationId,
}: {
  operationId: string;
}) {
  const t = useTranslations('McpOperation');
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  const [files, setFiles] = useState<File[]>([]),
    [role, setRole] = useState<
      'question' | 'answer' | 'solution' | 'student_work' | 'other'
    >('question');
  const [allowRead, setAllowRead] = useState(false),
    [allowCreate, setAllowCreate] = useState(false);
  const endpoint = `/api/mcp/operations/${operationId}`;
  const label = (prefix: 'states' | 'fields', value: string) => {
    const key = `${prefix}.${value}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : value;
  };
  const explainError = useCallback(
    (e: unknown, fallback: string) => {
      if (isApiError(e)) {
        if (e.status === 401) return t('signInRequired');
        if (e.status === 0) return t('networkFailed');
      }
      return localizedApiErrorMessage(
        e,
        ERROR_KEYS,
        t as TranslatorProp,
        fallback
      );
    },
    [t]
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const body = await apiGet<{ data: Preview }>(endpoint, {
        cache: 'no-store',
        signal,
      });
      return body.data;
    },
    [endpoint]
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setPreview(value);
          setError('');
        }
      })
      .catch(e => {
        if (!controller.signal.aborted)
          setError(explainError(e, t('loadFailed')));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [load, explainError, t]);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setPreview(await load());
    } catch (e) {
      setError(explainError(e, t('loadFailed')));
    } finally {
      setBusy(false);
    }
  }
  async function run(body: Record<string, unknown>) {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await apiPost(endpoint, { ...body, nonce: preview.nonce });
      setFiles([]);
      try {
        setPreview(await load());
      } catch {
        setError(t('savedRefreshFailed'));
      }
    } catch (e) {
      setError(explainError(e, t('saveFailed')));
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!preview?.resource_id || !files.length) return;
    setBusy(true);
    setError('');
    try {
      const paths = await uploadFiles(
        files,
        role === 'solution' ? 'solution' : 'problem',
        preview.resource_id
      );
      await run({
        kind: 'action',
        action: 'images',
        assets: paths.map(path => ({ path, role })),
        expected_revision: preview.before?.revision,
      });
    } catch (e) {
      setError(explainError(e, t('saveFailed')));
    } finally {
      setBusy(false);
    }
  }
  async function grantAccess() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await apiPut(`/api/words/decks/${preview.resource_id}/ai-access`, {
        can_read: allowRead,
        can_create: allowCreate,
      });
      await run({ kind: 'action', action: 'word_deck_access' });
    } catch (e) {
      setError(explainError(e, t('saveFailed')));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5" aria-busy={busy}>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
        {t('refresh')}
      </Button>
      {!preview ? (
        <p>{t('loading')}</p>
      ) : (
        <>
          <p>
            {t('state')}: {label('states', preview.state)}
          </p>
          {preview.revision_changed && <p role="alert">{t('changed')}</p>}
          {preview.state === 'awaiting_approval' && (
            <div className="landing-card space-y-5">
              <p>{t('review')}</p>
              {Object.entries(preview.changes ?? {}).map(([field, value]) => (
                <div key={field} className="space-y-2">
                  <h2 className="font-semibold">{label('fields', field)}</h2>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <p>{t('before')}</p>
                      <Value
                        field={field}
                        value={preview.before?.[field]}
                        rich={preview.resource_type === 'problem'}
                      />
                    </div>
                    <div>
                      <p>{t('after')}</p>
                      <Value
                        field={field}
                        value={value}
                        rich={preview.resource_type === 'problem'}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex gap-3">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run({ kind: 'decision', decision: 'approved' })
                  }
                >
                  {t('approve')}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run({ kind: 'decision', decision: 'rejected' })
                  }
                >
                  {t('reject')}
                </Button>
              </div>
            </div>
          )}
          {preview.actions
            .filter(a => a.state === 'pending' && a.kind === 'initial_idea')
            .map(a => (
              <div className="landing-card space-y-3" key={a.id}>
                <h2 className="font-semibold">{t('idea')}</h2>
                <p>{t('ideaHint')}</p>
                <p>{t('before')}</p>
                <pre className="whitespace-pre-wrap">
                  {format(preview.before?.initial_idea)}
                </pre>
                <p>{t('after')}</p>
                <pre className="whitespace-pre-wrap">{a.idea}</pre>
                <div className="flex gap-3">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run({ kind: 'action', action: 'initial_idea' })
                    }
                  >
                    {t('confirmIdea')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run({
                        kind: 'action',
                        action: 'dismiss_initial_idea',
                      })
                    }
                  >
                    {t('reject')}
                  </Button>
                </div>
              </div>
            ))}
          {preview.resource_type === 'problem' &&
            preview.state === 'committed' && (
              <div className="landing-card space-y-3">
                <h2 className="font-semibold">{t('images')}</h2>
                <p>{t('imagesHint')}</p>
                <label className="block">
                  {t('imageRole')}{' '}
                  <select
                    value={role}
                    onChange={e => setRole(e.target.value as typeof role)}
                    className="rounded border bg-background p-2"
                  >
                    {(
                      [
                        'question',
                        'answer',
                        'solution',
                        'student_work',
                        'other',
                      ] as const
                    ).map(r => (
                      <option key={r} value={r}>
                        {t(`roles.${r}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  aria-label={t('chooseFiles')}
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={busy}
                  onChange={e => setFiles(Array.from(e.target.files ?? []))}
                />
                <Button
                  disabled={busy || !files.length}
                  onClick={() => void upload()}
                >
                  {t('upload')}
                </Button>
                <div className="grid grid-cols-2 gap-3">
                  {preview.images
                    ?.filter(a => a.url)
                    .map(a => (
                      <a
                        key={a.path}
                        href={a.url!}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Image
                          unoptimized
                          width={480}
                          height={300}
                          src={a.url!}
                          alt={t('imagePreview')}
                          className="max-h-60 rounded border object-contain"
                        />
                      </a>
                    ))}
                </div>
                {preview.actions.some(
                  a => a.kind === 'images' && a.state === 'pending'
                ) && (
                  <>
                    <p>{t('imagesPending')}</p>
                    <Button
                      disabled={busy || !preview.images?.length}
                      variant="outline"
                      onClick={() =>
                        void run({
                          kind: 'action',
                          action: 'confirm_images',
                          expected_revision: preview.before?.revision,
                        })
                      }
                    >
                      {t('confirmImages')}
                    </Button>
                  </>
                )}
              </div>
            )}
          {preview.actions.some(
            a => a.kind === 'word_deck_access' && a.state === 'pending'
          ) && (
            <div className="landing-card space-y-3">
              <h2 className="font-semibold">{t('wordAccess')}</h2>
              <p>{t('wordAccessHint')}</p>
              <label className="block">
                <input
                  type="checkbox"
                  checked={allowRead}
                  onChange={e => setAllowRead(e.target.checked)}
                />{' '}
                {t('allowRead')}
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  checked={allowCreate}
                  onChange={e => setAllowCreate(e.target.checked)}
                />{' '}
                {t('allowCreate')}
              </label>
              <Button disabled={busy} onClick={() => void grantAccess()}>
                {t('saveAccess')}
              </Button>
              <Link href={`/words/decks/${preview.resource_id}`}>
                {t('openResource')}
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

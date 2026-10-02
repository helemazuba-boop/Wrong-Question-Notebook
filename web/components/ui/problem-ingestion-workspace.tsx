'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ImagePlus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { TranslatorProp } from '@/i18n/types';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { uploadFiles } from '@/lib/storage/client';
import type {
  ProblemIngestionCandidateAsset,
  ProblemIngestionWorkspace,
  ProblemIngestionWorkspaceCandidate,
} from '@/lib/problem-ingestion-workspace-contract';

interface ProblemIngestionWorkspaceProps {
  ingestionId: string;
  onClose: () => void;
  onImported?: (count: number) => void;
  /** When set, newly accepted problems are linked into this problem set. */
  problemSetId?: string;
}

type AssetRole = 'assets' | 'solution_assets';

const MAX_CANDIDATE_ASSETS = 20;
const MAX_ASSET_NAME_LENGTH = 255;

/** API error carrying the structured code/details the backend attaches. */
class WorkspaceApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errorDetails?: unknown;

  constructor(
    message: string,
    status: number,
    code?: string,
    errorDetails?: unknown
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.code = code;
    this.errorDetails = errorDetails;
  }
}

function fileUrl(path: string): string {
  return `/api/files/${encodeURIComponent(path)}`;
}

async function responseWorkspace(response: Response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WorkspaceApiError(
      json.error || 'Workspace request failed',
      response.status,
      json.details?.code,
      json.details?.details
    );
  }
  return json.data.workspace as ProblemIngestionWorkspace;
}

type Translator = TranslatorProp;

const WORKSPACE_ERROR_KEYS: Record<string, string> = {
  image_asset_required: 'workspaceErrorImageAssetRequired',
  no_problem_detected: 'workspaceErrorNoProblem',
  too_many_problems_detected: 'workspaceErrorTooMany',
  duplicate_question_ids: 'workspaceErrorDuplicateIds',
  invalid_ingestion_document: 'workspaceErrorInvalidDocument',
  subject_not_found: 'workspaceErrorSubjectMissing',
  empty_question_content: 'workspaceErrorEmptyContent',
  problem_limit_reached: 'workspaceErrorProblemLimit',
  storage_limit_reached: 'workspaceErrorStorageLimit',
  candidate_skipped: 'workspaceErrorCandidateSkipped',
  candidate_already_accepted: 'workspaceErrorAlreadyAccepted',
  reserved_problem_id_conflict: 'workspaceErrorIdConflict',
  invalid_asset_path: 'workspaceErrorInvalidAssetPath',
  ingestion_not_found: 'workspaceErrorNotFound',
};

/**
 * Maps known backend error codes to localized messages; anything unknown
 * (including network failures) falls back to the raw message or a generic
 * localized string.
 */
function workspaceErrorMessage(
  t: Translator,
  error: unknown,
  fallback: string
): string {
  if (error instanceof WorkspaceApiError && error.code) {
    const key = WORKSPACE_ERROR_KEYS[error.code];
    if (key) return t(key);
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ProblemIngestionWorkspacePanel({
  ingestionId,
  onClose,
  onImported,
  problemSetId,
}: ProblemIngestionWorkspaceProps) {
  const t = useTranslations('ImageScan');
  const [workspace, setWorkspace] = useState<ProblemIngestionWorkspace | null>(
    null
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyQuestion, setBusyQuestion] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedSelection = useRef(false);

  const applyWorkspace = useCallback((next: ProblemIngestionWorkspace) => {
    setWorkspace(next);
    setSelected(previous => {
      const selectable = new Set(
        next.candidates
          .filter(candidate => candidate.status === 'pending')
          .map(candidate => candidate.question_id)
      );
      if (!initializedSelection.current) {
        initializedSelection.current = true;
        return selectable;
      }
      return new Set([...previous].filter(id => selectable.has(id)));
    });
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      applyWorkspace(
        await responseWorkspace(
          await fetch(`/api/problem-ingestions/${ingestionId}`, {
            cache: 'no-store',
          })
        )
      );
    } catch (loadError) {
      setError(workspaceErrorMessage(t, loadError, t('workspaceLoadFailed')));
    }
  }, [applyWorkspace, ingestionId, t]);

  useEffect(() => {
    initializedSelection.current = false;
    setWorkspace(null);
    setSelected(new Set());
    void reload();
  }, [reload]);

  const patchCandidate = useCallback(
    async (
      candidate: ProblemIngestionWorkspaceCandidate,
      patch: Partial<
        Pick<
          ProblemIngestionWorkspaceCandidate,
          'assets' | 'solution_assets' | 'status'
        >
      >
    ) => {
      setBusyQuestion(candidate.question_id);
      try {
        const next = await responseWorkspace(
          await fetch(
            `/api/problem-ingestions/${ingestionId}/candidates/${encodeURIComponent(candidate.question_id)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            }
          )
        );
        applyWorkspace(next);
      } finally {
        setBusyQuestion(null);
      }
    },
    [applyWorkspace, ingestionId]
  );

  const uploadAssets = useCallback(
    async (
      candidate: ProblemIngestionWorkspaceCandidate,
      role: AssetRole,
      fileList: FileList
    ) => {
      // Snapshot the FileList before any await: the caller resets the input
      // value immediately, and engines may empty the captured list in place.
      const files = Array.from(fileList);
      if (files.length === 0) return;
      const existing = candidate[role];
      if (existing.length + files.length > MAX_CANDIDATE_ASSETS) {
        toast.error(t('workspaceTooManyImages'));
        return;
      }
      if (files.some(file => file.name.length > MAX_ASSET_NAME_LENGTH)) {
        toast.error(t('workspaceInvalidImageName'));
        return;
      }
      setBusyQuestion(candidate.question_id);
      const storageRole = role === 'assets' ? 'problem' : 'solution';
      let uploadedPaths: string[] = [];
      let cleanupPaths: string[] = [];
      try {
        uploadedPaths = await uploadFiles(
          files,
          storageRole,
          candidate.problem_id
        );
        const existingPaths = new Set(existing.map(asset => asset.path));
        cleanupPaths = uploadedPaths.filter(path => !existingPaths.has(path));
        const appended = uploadedPaths
          .map((path, index) => ({
            path,
            name: files[index]?.name || t('uploadedImage'),
            part_id: null,
          }))
          .filter(asset => !existingPaths.has(asset.path));
        const next = await responseWorkspace(
          await fetch(
            `/api/problem-ingestions/${ingestionId}/candidates/${encodeURIComponent(candidate.question_id)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ [role]: [...existing, ...appended] }),
            }
          )
        );
        applyWorkspace(next);
      } catch (uploadError) {
        // A 5xx may have committed the DB update before the response failed,
        // leaving the candidate row referencing these objects — keep the
        // files so a retry does not strand stored asset paths.
        const status =
          uploadError instanceof WorkspaceApiError
            ? uploadError.status
            : undefined;
        if (status === undefined || status < 500) {
          await Promise.allSettled(
            cleanupPaths.map(path =>
              fetch('/api/files/delete', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
              })
            )
          );
        }
        toast.error(
          workspaceErrorMessage(t, uploadError, t('workspaceUploadFailed'))
        );
      } finally {
        setBusyQuestion(null);
      }
    },
    [applyWorkspace, ingestionId, t]
  );

  const replaceAssetOrder = useCallback(
    async (
      candidate: ProblemIngestionWorkspaceCandidate,
      role: AssetRole,
      assets: ProblemIngestionCandidateAsset[]
    ) => {
      try {
        await patchCandidate(candidate, { [role]: assets });
      } catch (patchError) {
        toast.error(
          workspaceErrorMessage(t, patchError, t('workspaceOrderFailed'))
        );
      }
    },
    [patchCandidate, t]
  );

  const moveAsset = useCallback(
    (
      candidate: ProblemIngestionWorkspaceCandidate,
      role: AssetRole,
      from: number,
      to: number
    ) => {
      if (to < 0 || to >= candidate[role].length || from === to) return;
      const next = [...candidate[role]];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void replaceAssetOrder(candidate, role, next);
    },
    [replaceAssetOrder]
  );

  const removeAsset = useCallback(
    async (
      candidate: ProblemIngestionWorkspaceCandidate,
      role: AssetRole,
      asset: ProblemIngestionCandidateAsset
    ) => {
      setBusyQuestion(candidate.question_id);
      try {
        const next = candidate[role].filter(item => item.path !== asset.path);
        const updated = await responseWorkspace(
          await fetch(
            `/api/problem-ingestions/${ingestionId}/candidates/${encodeURIComponent(candidate.question_id)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ [role]: next }),
            }
          )
        );
        applyWorkspace(updated);
        const response = await fetch('/api/files/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: asset.path }),
        });
        if (!response.ok) {
          const json = await response.json().catch(() => ({}));
          toast.error(json.error || t('workspaceDeleteImageFailed'));
        }
      } catch (removeError) {
        toast.error(
          workspaceErrorMessage(t, removeError, t('workspaceDeleteImageFailed'))
        );
      } finally {
        setBusyQuestion(null);
      }
    },
    [applyWorkspace, ingestionId, t]
  );

  const acceptSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setAccepting(true);
    try {
      const count = selected.size;
      const requestedIds = [...selected];
      const next = await responseWorkspace(
        await fetch(`/api/problem-ingestions/${ingestionId}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question_ids: requestedIds }),
        })
      );
      applyWorkspace(next);
      // Problems land in the subject; when the import was started from a
      // problem set, also link them into that set so they show up there.
      if (problemSetId) {
        const acceptedIds = next.candidates
          .filter(
            candidate =>
              requestedIds.includes(candidate.question_id) &&
              candidate.accepted_problem_id
          )
          .map(candidate => candidate.accepted_problem_id as string);
        if (acceptedIds.length > 0) {
          try {
            const response = await fetch(
              `/api/problem-sets/${problemSetId}/problems`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ problem_ids: acceptedIds }),
              }
            );
            if (!response.ok) throw new Error('set link failed');
          } catch {
            toast.warning(t('workspaceSetLinkFailed'));
          }
        }
      }
      toast.success(t('workspaceImported', { count }));
      onImported?.(count);
    } catch (acceptError) {
      if (
        acceptError instanceof WorkspaceApiError &&
        acceptError.code === 'image_asset_required'
      ) {
        const missingIds = new Set(
          (acceptError.errorDetails as { question_ids?: string[] })
            ?.question_ids ?? []
        );
        const labels = (workspace?.candidates ?? [])
          .filter(candidate => missingIds.has(candidate.question_id))
          .map(
            candidate => candidate.draft.number_label || candidate.draft.title
          )
          .filter(Boolean);
        toast.error(
          t('workspaceErrorImageAssetRequiredList', {
            labels: labels.join('、'),
          })
        );
      } else {
        toast.error(
          workspaceErrorMessage(t, acceptError, t('workspaceImportFailed'))
        );
      }
    } finally {
      setAccepting(false);
    }
  }, [
    applyWorkspace,
    ingestionId,
    onImported,
    problemSetId,
    selected,
    t,
    workspace,
  ]);

  const discard = useCallback(async () => {
    if (!window.confirm(t('workspaceDiscardConfirm'))) return;
    setDiscarding(true);
    try {
      const response = await fetch(`/api/problem-ingestions/${ingestionId}`, {
        method: 'DELETE',
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(json.error || t('workspaceDiscardFailed'));
      onClose();
    } catch (discardError) {
      toast.error(
        workspaceErrorMessage(t, discardError, t('workspaceDiscardFailed'))
      );
    } finally {
      setDiscarding(false);
    }
  }, [ingestionId, onClose, t]);

  if (!workspace) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-2xl border border-gray-200/60 dark:border-gray-700/40">
        {error ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
            <Button type="button" size="sm" onClick={() => void reload()}>
              <RotateCcw className="mr-1 h-4 w-4" />
              {t('workspaceRetry')}
            </Button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  const pending = workspace.candidates.filter(
    candidate => candidate.status !== 'accepted'
  );
  const acceptedCount = workspace.candidates.filter(
    candidate => candidate.status === 'accepted'
  ).length;
  const canDiscard = workspace.candidates.every(
    candidate => candidate.status !== 'accepted'
  );

  const assetList = (
    candidate: ProblemIngestionWorkspaceCandidate,
    role: AssetRole,
    label: string
  ) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
          {label}
        </span>
        {candidate.status !== 'accepted' && (
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:border-amber-300 hover:text-amber-700 dark:border-gray-700 dark:text-gray-300">
            <ImagePlus className="h-3.5 w-3.5" />
            {t('workspaceAddImages')}
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              disabled={busyQuestion === candidate.question_id}
              onChange={event => {
                if (event.target.files) {
                  void uploadAssets(candidate, role, event.target.files);
                }
                event.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      {candidate[role].length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400 dark:border-gray-700">
          {t('workspaceNoImages')}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {candidate[role].map((asset, index) => (
            <li
              key={asset.path}
              draggable={candidate.status !== 'accepted'}
              onDragStart={event => {
                event.dataTransfer.setData(
                  'text/plain',
                  JSON.stringify({
                    questionId: candidate.question_id,
                    role,
                    index,
                  })
                );
              }}
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                event.preventDefault();
                try {
                  const source = JSON.parse(
                    event.dataTransfer.getData('text/plain')
                  ) as {
                    questionId?: string;
                    role?: AssetRole;
                    index?: number;
                  };
                  if (
                    source.questionId === candidate.question_id &&
                    source.role === role &&
                    Number.isInteger(source.index)
                  ) {
                    moveAsset(candidate, role, source.index as number, index);
                  }
                } catch {
                  // Ignore drops that did not originate from this asset list.
                }
              }}
              className="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-white p-1.5 dark:border-gray-700/60 dark:bg-gray-900/50"
            >
              <span className="w-5 text-center text-xs font-semibold text-gray-400">
                {index + 1}
              </span>
              <Image
                src={fileUrl(asset.path)}
                alt={asset.name}
                width={40}
                height={40}
                unoptimized
                className="h-10 w-10 rounded object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300">
                {asset.name}
              </span>
              {candidate.status !== 'accepted' && (
                <div className="flex items-center">
                  <button
                    type="button"
                    disabled={
                      index === 0 || busyQuestion === candidate.question_id
                    }
                    onClick={() => moveAsset(candidate, role, index, index - 1)}
                    aria-label={t('workspaceMoveUp')}
                    className="rounded p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={
                      index === candidate[role].length - 1 ||
                      busyQuestion === candidate.question_id
                    }
                    onClick={() => moveAsset(candidate, role, index, index + 1)}
                    aria-label={t('workspaceMoveDown')}
                    className="rounded p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busyQuestion === candidate.question_id}
                    onClick={() => void removeAsset(candidate, role, asset)}
                    aria-label={t('remove')}
                    className="rounded p-1 text-gray-400 hover:text-rose-600 disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200/60 bg-amber-50/50 px-3 py-2 dark:border-amber-800/40 dark:bg-amber-950/20">
        <div>
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t('workspaceTitle')}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('workspaceSummary', {
              count: workspace.candidates.length,
              pending: pending.length,
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending.length === 0}
            onClick={() =>
              setSelected(
                selected.size ===
                  pending.filter(candidate => candidate.status === 'pending')
                    .length
                  ? new Set()
                  : new Set(
                      pending
                        .filter(candidate => candidate.status === 'pending')
                        .map(candidate => candidate.question_id)
                    )
              )
            }
          >
            {t('workspaceSelectAll')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={selected.size === 0 || accepting}
            onClick={() => void acceptSelected()}
          >
            {accepting ? (
              <Spinner className="mr-1" />
            ) : (
              <CheckCircle2 className="mr-1 h-4 w-4" />
            )}
            {t('workspaceImportSelected', { count: selected.size })}
          </Button>
        </div>
      </div>

      {acceptedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200/60 bg-emerald-50/50 px-3 py-2 dark:border-emerald-800/40 dark:bg-emerald-950/20">
          <p className="text-sm text-emerald-800 dark:text-emerald-300">
            {t('workspaceAcceptedCount', { count: acceptedCount })}
          </p>
          <div className="flex items-center gap-3 text-xs">
            {problemSetId && (
              <Link
                href={`/problem-sets/${problemSetId}`}
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-300"
              >
                {t('workspaceViewImported')}
              </Link>
            )}
            {workspace.subject_id && (
              <Link
                href={`/subjects/${workspace.subject_id}/problems`}
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-300"
              >
                {t('workspaceViewSubjectProblems')}
              </Link>
            )}
          </div>
        </div>
      )}

      {workspace.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200/60 px-3 py-2 text-xs text-amber-700 dark:border-amber-800/40 dark:text-amber-300">
          {workspace.warnings.join(' · ')}
        </div>
      )}

      <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
        {workspace.candidates.map(candidate => {
          const disabled = candidate.status === 'accepted';
          const isEmptyDraft =
            !candidate.draft.content.trim() &&
            candidate.draft.parts.every(
              part =>
                part.content.trim() === '' &&
                part.mcq_choices.every(choice => choice.text.trim() === '')
            );
          return (
            <article
              key={candidate.question_id}
              className={`space-y-3 rounded-2xl border p-3 ${
                disabled
                  ? 'border-emerald-200/70 bg-emerald-50/30 dark:border-emerald-800/40 dark:bg-emerald-950/10'
                  : candidate.status === 'skipped'
                    ? 'border-gray-200/70 opacity-70 dark:border-gray-700/50'
                    : 'border-gray-200/70 dark:border-gray-700/50'
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(candidate.question_id)}
                  disabled={candidate.status !== 'pending'}
                  onChange={event =>
                    setSelected(previous => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(candidate.question_id);
                      else next.delete(candidate.question_id);
                      return next;
                    })
                  }
                  className="mt-1 h-4 w-4 accent-amber-500"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                      {candidate.draft.number_label || candidate.position}
                    </span>
                    <h3 className="truncate text-sm font-semibold text-gray-800 dark:text-gray-200">
                      {candidate.draft.title}
                    </h3>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {t('partsCount', { count: candidate.draft.parts.length })}
                    </span>
                    {candidate.draft.suggest_image_asset &&
                      candidate.assets.length === 0 &&
                      candidate.status !== 'accepted' && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                          {t('workspaceProblemImageRequired')}
                        </span>
                      )}
                    {isEmptyDraft && candidate.status !== 'accepted' && (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                        {t('workspaceEmptyContent')}
                      </span>
                    )}
                    {candidate.status === 'accepted' && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        {t('workspaceAccepted')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
                    {[
                      candidate.draft.content,
                      ...candidate.draft.parts.map(part => part.content),
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  </p>
                  <details className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                    <summary className="cursor-pointer font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                      {t('workspaceQuestionDetails')}
                    </summary>
                    <div className="mt-2 space-y-2 rounded-lg bg-gray-50/70 p-2 dark:bg-gray-900/40">
                      {candidate.draft.content && (
                        <p className="whitespace-pre-wrap">
                          {candidate.draft.content}
                        </p>
                      )}
                      {candidate.draft.parts.map(part => (
                        <div key={part.index} className="space-y-1">
                          <p className="whitespace-pre-wrap">
                            {candidate.draft.parts.length > 1
                              ? `${part.label || `(${part.index})`} `
                              : ''}
                            {part.content}
                          </p>
                          {part.mcq_choices.map(choice => (
                            <p
                              key={choice.id}
                              className="whitespace-pre-wrap pl-3"
                            >
                              {choice.id}. {choice.text}
                            </p>
                          ))}
                        </div>
                      ))}
                      {candidate.draft.new_tag_names.length > 0 && (
                        <p className="text-[11px] text-gray-500 dark:text-gray-400">
                          {t('suggestedTags')}:{' '}
                          {candidate.draft.new_tag_names.join(' · ')}
                        </p>
                      )}
                    </div>
                  </details>
                  {candidate.draft.confidence.warnings.length > 0 && (
                    <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                      {candidate.draft.confidence.warnings.join(' · ')}
                    </p>
                  )}
                </div>
                {!disabled && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busyQuestion === candidate.question_id}
                    onClick={() =>
                      void patchCandidate(candidate, {
                        status:
                          candidate.status === 'skipped'
                            ? 'pending'
                            : 'skipped',
                      }).catch(patchError =>
                        toast.error(
                          workspaceErrorMessage(
                            t,
                            patchError,
                            t('workspaceUpdateFailed')
                          )
                        )
                      )
                    }
                  >
                    {candidate.status === 'skipped' ? (
                      <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <X className="mr-1 h-3.5 w-3.5" />
                    )}
                    {candidate.status === 'skipped'
                      ? t('workspaceRestore')
                      : t('workspaceSkip')}
                  </Button>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {assetList(candidate, 'assets', t('problemAsset'))}
                {assetList(candidate, 'solution_assets', t('solutionAsset'))}
              </div>
            </article>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <div>
          {canDiscard && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={discarding}
              onClick={() => void discard()}
              className="text-rose-600 hover:text-rose-700"
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {t('workspaceDiscard')}
            </Button>
          )}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          {t('workspaceClose')}
        </Button>
      </div>
    </div>
  );
}

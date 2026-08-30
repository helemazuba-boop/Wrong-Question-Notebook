import { createServiceClient } from '@/lib/supabase-utils';
import { FILE_CONSTANTS } from '@/lib/constants';
import { NotebookToolError } from '@/lib/notebooks';
import {
  EinkDerivationError,
  renderEinkDerivations,
} from '@/lib/eink-derivation-service';
import type { NoteImageAsset } from '@/lib/notebook-content-service';

// Orchestrates the storage side of note image attachments. The original is
// uploaded client-side into problem-uploads (same direct-upload flow as
// problem assets, under user/{uid}/notes/{noteId}/); the shared derivation
// pipeline renders the e-ink objects next to it and this module cleans the
// original plus all four derived objects on detach.

const BUCKET = FILE_CONSTANTS.STORAGE.BUCKET;

export function noteImageBasePath(userId: string, noteId: string): string {
  return `user/${userId}/notes/${noteId}`;
}

export function isOwnedNoteImagePath(
  userId: string,
  noteId: string,
  path: string
): boolean {
  return (
    !path.includes('..') &&
    !path.includes('\\') &&
    path.startsWith(`${noteImageBasePath(userId, noteId)}/`) &&
    !path.includes('/derived/')
  );
}

/**
 * Renders the WQNI + preview derivations for an already-uploaded original and
 * returns the asset record to attach. Derived objects are immutable and
 * content-addressed, so re-rendering the same original is idempotent.
 */
export async function renderNoteImageDerivations(
  userId: string,
  noteId: string,
  originalPath: string
): Promise<NoteImageAsset> {
  if (!isOwnedNoteImagePath(userId, noteId, originalPath)) {
    throw new NotebookToolError('invalid_request', 'Invalid image path', 400);
  }

  try {
    return await renderEinkDerivations(
      originalPath,
      `${noteImageBasePath(userId, noteId)}/derived`
    );
  } catch (error) {
    if (error instanceof EinkDerivationError) {
      switch (error.code) {
        case 'not_found':
          throw new NotebookToolError('note_not_found', 'Image not found', 404);
        case 'invalid_image':
          throw new NotebookToolError('invalid_request', error.message, 400);
        case 'storage_error':
          throw new NotebookToolError('database_error', error.message, 500);
      }
    }
    throw error;
  }
}

/** Best-effort removal of a detached asset's storage objects. */
export async function deleteNoteImageObjects(
  asset: NoteImageAsset,
  retainedAssets: NoteImageAsset[] = []
): Promise<void> {
  const service = createServiceClient();
  const retainedPaths = new Set(
    retainedAssets.flatMap(value =>
      [
        value.path,
        value.display_path,
        value.preview_path,
        value.gray4_display_path,
        value.gray4_preview_path,
      ].filter((path): path is string => typeof path === 'string')
    )
  );
  const removable = [
    asset.path,
    asset.display_path,
    asset.preview_path,
    asset.gray4_display_path,
    asset.gray4_preview_path,
  ].filter(
    (path): path is string =>
      typeof path === 'string' && !retainedPaths.has(path)
  );
  if (removable.length > 0) {
    const { error } = await service.storage.from(BUCKET).remove(removable);
    if (error) {
      throw new NotebookToolError(
        'database_error',
        'Failed to remove detached image objects',
        500
      );
    }
  }
}

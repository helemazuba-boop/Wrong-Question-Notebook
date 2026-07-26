import { createServiceClient } from '@/lib/supabase-utils';
import { FILE_CONSTANTS } from '@/lib/constants';
import { NotebookToolError } from '@/lib/notebooks';
import {
  EINK_IMAGE_MAX_INPUT_BYTES,
  EinkImageError,
  renderEinkImage,
} from '@/lib/eink-image';
import type { NoteImageAsset } from '@/lib/notebook-content-service';

// Orchestrates the storage side of note image attachments. The original is
// uploaded client-side into problem-uploads (same direct-upload flow as
// problem assets, under user/{uid}/notes/{noteId}/); this module renders the
// e-ink derivation next to it and cleans all three objects up on detach.

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
 * returns the asset record to attach. Derived objects are content-addressed by
 * image_id, so re-rendering the same original overwrites identical bytes.
 */
export async function renderNoteImageDerivations(
  userId: string,
  noteId: string,
  originalPath: string
): Promise<NoteImageAsset> {
  if (!isOwnedNoteImagePath(userId, noteId, originalPath)) {
    throw new NotebookToolError('invalid_request', 'Invalid image path', 400);
  }

  const service = createServiceClient();
  const { data: blob, error: downloadError } = await service.storage
    .from(BUCKET)
    .download(originalPath);
  if (downloadError || !blob) {
    throw new NotebookToolError('note_not_found', 'Image not found', 404);
  }
  if (blob.size > EINK_IMAGE_MAX_INPUT_BYTES) {
    throw new NotebookToolError('invalid_request', 'Image too large', 400);
  }
  const original = Buffer.from(await blob.arrayBuffer());

  let rendered;
  try {
    rendered = await renderEinkImage(original);
  } catch (error) {
    if (error instanceof EinkImageError) {
      throw new NotebookToolError('invalid_request', error.message, 400);
    }
    throw error;
  }

  const base = `${noteImageBasePath(userId, noteId)}/derived/${rendered.imageId}`;
  const displayPath = `${base}.wqni`;
  const previewPath = `${base}.png`;

  const { error: wqniError } = await service.storage
    .from(BUCKET)
    .upload(displayPath, rendered.wqni, {
      contentType: 'application/octet-stream',
      cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
      upsert: true,
    });
  if (wqniError) {
    throw new NotebookToolError('database_error', wqniError.message, 500);
  }
  const { error: previewError } = await service.storage
    .from(BUCKET)
    .upload(previewPath, rendered.preview, {
      contentType: 'image/png',
      cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
      upsert: true,
    });
  if (previewError) {
    throw new NotebookToolError('database_error', previewError.message, 500);
  }

  return {
    path: originalPath,
    image_id: rendered.imageId,
    display_path: displayPath,
    preview_path: previewPath,
  };
}

/** Best-effort removal of a detached asset's storage objects. */
export async function deleteNoteImageObjects(
  asset: NoteImageAsset
): Promise<void> {
  const service = createServiceClient();
  await service.storage
    .from(BUCKET)
    .remove([asset.path, asset.display_path, asset.preview_path]);
}

/**
 * Best-effort removal of only the derived objects (.wqni/.png). Used when the
 * attach CAS fails after derivation: the client-uploaded original must stay so
 * a retry can re-render, but orphaned derivations would otherwise leak.
 */
export async function deleteNoteImageDerivedObjects(
  asset: NoteImageAsset
): Promise<void> {
  const service = createServiceClient();
  await service.storage
    .from(BUCKET)
    .remove([asset.display_path, asset.preview_path]);
}

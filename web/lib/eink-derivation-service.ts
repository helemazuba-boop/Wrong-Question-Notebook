import { createServiceClient } from '@/lib/supabase-utils';
import { FILE_CONSTANTS } from '@/lib/constants';
import {
  EINK_IMAGE_MAX_INPUT_BYTES,
  EinkImageError,
  renderEinkImage,
} from '@/lib/eink-image';

// Generic WQNI derivation pipeline shared by every image-bearing domain
// (note attachments, problem assets, solution assets). Downloads an
// already-uploaded original from storage, renders the device framebuffer
// (.wqni) plus the pixel-identical preview (.png) next to it, and returns
// the derivation record callers persist alongside the original path.
//
// Callers are responsible for authorising originalPath; this module only
// enforces the rendering limits.

const BUCKET = FILE_CONSTANTS.STORAGE.BUCKET;

export interface EinkDerivedAsset {
  path: string;
  image_id: string;
  display_path: string;
  preview_path: string;
}

export class EinkDerivationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_image' | 'storage_error',
    message: string
  ) {
    super(message);
    this.name = 'EinkDerivationError';
  }
}

/**
 * Renders the WQNI + preview derivations for an already-uploaded original.
 * Derived objects are content-addressed by image_id under derivedDir, so
 * re-rendering the same original overwrites identical bytes (idempotent).
 */
export async function renderEinkDerivations(
  originalPath: string,
  derivedDir: string
): Promise<EinkDerivedAsset> {
  const service = createServiceClient();
  const { data: blob, error: downloadError } = await service.storage
    .from(BUCKET)
    .download(originalPath);
  if (downloadError || !blob) {
    throw new EinkDerivationError('not_found', 'Image not found');
  }
  if (blob.size > EINK_IMAGE_MAX_INPUT_BYTES) {
    throw new EinkDerivationError('invalid_image', 'Image too large');
  }
  const original = Buffer.from(await blob.arrayBuffer());

  let rendered;
  try {
    rendered = await renderEinkImage(original);
  } catch (error) {
    if (error instanceof EinkImageError) {
      throw new EinkDerivationError('invalid_image', error.message);
    }
    throw error;
  }

  const base = `${derivedDir}/${rendered.imageId}`;
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
    throw new EinkDerivationError('storage_error', wqniError.message);
  }
  const { error: previewError } = await service.storage
    .from(BUCKET)
    .upload(previewPath, rendered.preview, {
      contentType: 'image/png',
      cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
      upsert: true,
    });
  if (previewError) {
    throw new EinkDerivationError('storage_error', previewError.message);
  }

  return {
    path: originalPath,
    image_id: rendered.imageId,
    display_path: displayPath,
    preview_path: previewPath,
  };
}

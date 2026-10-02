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
export const EINK_DERIVATION_PIPELINE_VERSION = 'wqni-bw1-gray4-v2';

export interface EinkDerivedAsset {
  path: string;
  pipeline_version: string;
  image_id: string;
  display_path: string;
  preview_path: string;
  gray4_image_id: string;
  gray4_display_path: string;
  gray4_preview_path: string;
}

function isDuplicateObjectError(error: {
  message: string;
  status?: number;
  statusCode?: string;
}): boolean {
  return (
    error.status === 409 ||
    error.statusCode === '409' ||
    /duplicate/i.test(error.statusCode ?? '') ||
    /already exists|duplicate|resource already exists/i.test(error.message)
  );
}

async function publishImmutableArtifact(
  service: ReturnType<typeof createServiceClient>,
  path: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  // Every path contains the SHA-256 of its bytes. Never overwrite it: a
  // duplicate is an idempotent success, while different bytes necessarily
  // publish under another key.
  const { error } = await service.storage.from(BUCKET).upload(path, body, {
    contentType,
    cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
    upsert: false,
  });
  if (error && !isDuplicateObjectError(error)) {
    console.error('Failed to publish immutable e-ink artifact:', {
      path,
      status: error.status,
      statusCode: error.statusCode,
      message: error.message,
    });
    throw new EinkDerivationError(
      'storage_error',
      'Failed to publish derived image artifact'
    );
  }
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
 * re-rendering the same original reuses immutable bytes (idempotent).
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
  const gray4DisplayPath = `${derivedDir}/${rendered.gray4ImageId}.gray4.wqni`;
  const gray4PreviewPath = `${derivedDir}/${rendered.gray4ImageId}.gray4.png`;

  // Wait for every immutable publication to settle. Promise.all would return
  // on the first rejection while sibling uploads were still mutating storage.
  // Partial immutable objects are safe and reusable by a retry; no caller may
  // reference the asset until all four publications have succeeded.
  const publications = await Promise.allSettled([
    publishImmutableArtifact(
      service,
      displayPath,
      rendered.wqni,
      'application/octet-stream'
    ),
    publishImmutableArtifact(
      service,
      gray4DisplayPath,
      rendered.gray4Wqni,
      'application/octet-stream'
    ),
    publishImmutableArtifact(
      service,
      previewPath,
      rendered.preview,
      'image/png'
    ),
    publishImmutableArtifact(
      service,
      gray4PreviewPath,
      rendered.gray4Preview,
      'image/png'
    ),
  ]);
  const failed = publications.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed) throw failed.reason;

  return {
    path: originalPath,
    pipeline_version: EINK_DERIVATION_PIPELINE_VERSION,
    image_id: rendered.imageId,
    display_path: displayPath,
    preview_path: previewPath,
    gray4_image_id: rendered.gray4ImageId,
    gray4_display_path: gray4DisplayPath,
    gray4_preview_path: gray4PreviewPath,
  };
}

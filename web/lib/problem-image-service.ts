import {
  renderEinkDerivations,
  EinkDerivationError,
} from '@/lib/eink-derivation-service';
import type { ProblemAsset } from '@/lib/schemas';

// Best-effort WQNI enrichment for problem/solution assets. Called from the
// problem create/update routes after ownership validation: every image asset
// that has no derivation yet gets .wqni/.png rendered next to its original
// (dirname(path)/derived/{image_id}.*). Failures never block the save -- the
// asset keeps only its original path and the backfill script (or the next
// edit) retries.

/** True when the asset plausibly holds a photo the e-ink pipeline accepts. */
function isImageAsset(asset: ProblemAsset): boolean {
  if (asset.kind === 'pdf') return false;
  if (asset.kind === 'image') return true;
  return !asset.path.toLowerCase().endsWith('.pdf');
}

export function problemAssetDerivedDir(originalPath: string): string {
  const slash = originalPath.lastIndexOf('/');
  const dir = slash >= 0 ? originalPath.slice(0, slash) : '';
  return `${dir}/derived`;
}

/**
 * Returns the assets array with derivation metadata filled in wherever it was
 * missing. Order and non-image entries are preserved as-is.
 */
export async function deriveProblemImageAssets(
  assets: ProblemAsset[]
): Promise<ProblemAsset[]> {
  return Promise.all(
    assets.map(async asset => {
      if (!isImageAsset(asset)) return asset;
      if (
        asset.image_id &&
        asset.display_path &&
        asset.preview_path &&
        asset.gray4_image_id &&
        asset.gray4_display_path &&
        asset.gray4_preview_path
      ) {
        return asset;
      }
      try {
        const derived = await renderEinkDerivations(
          asset.path,
          problemAssetDerivedDir(asset.path)
        );
        return { ...asset, ...derived };
      } catch (error) {
        // PDFs mislabeled as images, unreadable photos, transient storage
        // errors: keep the original-only asset and move on.
        const detail =
          error instanceof EinkDerivationError
            ? `${error.code}: ${error.message}`
            : error;
        console.warn(`[eink] derivation skipped for ${asset.path}:`, detail);
        return asset;
      }
    })
  );
}

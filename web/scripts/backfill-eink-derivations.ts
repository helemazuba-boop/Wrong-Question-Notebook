// One-off backfill: renders BW1 and GRAY4 WQNI/.png derivations for every
// existing problem image asset that predates either e-ink pipeline hookup.
// Idempotent -- complete assets are skipped, derived uploads use upsert, and
// per-asset failures are logged without aborting the run.
//
// Run from web/ with Node >= 24 (native type stripping):
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     node scripts/backfill-eink-derivations.ts
//
// Shares the exact renderer used by the API routes so backfilled bytes are
// identical to freshly attached ones (image_id = sha256 of the WQNI file).

import { createClient } from '@supabase/supabase-js';
import { renderEinkImage, EinkImageError } from '../lib/eink-image.ts';

const BUCKET = 'problem-uploads';
const PAGE_SIZE = 100;

interface AssetRecord {
  path?: unknown;
  kind?: unknown;
  image_id?: unknown;
  display_path?: unknown;
  preview_path?: unknown;
  gray4_image_id?: unknown;
  gray4_display_path?: unknown;
  gray4_preview_path?: unknown;
  [key: string]: unknown;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !secretKey) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set'
  );
  process.exit(1);
}

const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stats = { scanned: 0, rendered: 0, skipped: 0, failed: 0 };

function needsDerivation(asset: AssetRecord): boolean {
  if (typeof asset.path !== 'string' || asset.path.length === 0) return false;
  if (asset.kind === 'pdf') return false;
  if (asset.kind !== 'image' && asset.path.toLowerCase().endsWith('.pdf')) {
    return false;
  }
  return !(
    typeof asset.image_id === 'string' &&
    typeof asset.display_path === 'string' &&
    typeof asset.preview_path === 'string' &&
    typeof asset.gray4_image_id === 'string' &&
    typeof asset.gray4_display_path === 'string' &&
    typeof asset.gray4_preview_path === 'string'
  );
}

function derivedDirOf(originalPath: string): string {
  const slash = originalPath.lastIndexOf('/');
  return `${slash >= 0 ? originalPath.slice(0, slash) : ''}/derived`;
}

async function deriveOne(asset: AssetRecord): Promise<AssetRecord | null> {
  const originalPath = asset.path as string;
  const { data: blob, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(originalPath);
  if (downloadError || !blob) {
    throw new Error(`download failed: ${downloadError?.message ?? 'no blob'}`);
  }
  const original = Buffer.from(await blob.arrayBuffer());
  const rendered = await renderEinkImage(original);

  const base = `${derivedDirOf(originalPath)}/${rendered.imageId}`;
  const displayPath = `${base}.wqni`;
  const previewPath = `${base}.png`;
  const gray4Base = `${derivedDirOf(originalPath)}/${rendered.gray4ImageId}.gray4`;
  const gray4DisplayPath = `${gray4Base}.wqni`;
  const gray4PreviewPath = `${gray4Base}.png`;

  const { error: wqniError } = await supabase.storage
    .from(BUCKET)
    .upload(displayPath, rendered.wqni, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: true,
    });
  if (wqniError) throw new Error(`wqni upload failed: ${wqniError.message}`);

  const { error: previewError } = await supabase.storage
    .from(BUCKET)
    .upload(previewPath, rendered.preview, {
      contentType: 'image/png',
      cacheControl: '3600',
      upsert: true,
    });
  if (previewError) {
    throw new Error(`preview upload failed: ${previewError.message}`);
  }
  const { error: gray4Error } = await supabase.storage
    .from(BUCKET)
    .upload(gray4DisplayPath, rendered.gray4Wqni, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: true,
    });
  if (gray4Error) {
    throw new Error(`gray4 WQNI upload failed: ${gray4Error.message}`);
  }
  const { error: gray4PreviewError } = await supabase.storage
    .from(BUCKET)
    .upload(gray4PreviewPath, rendered.gray4Preview, {
      contentType: 'image/png',
      cacheControl: '3600',
      upsert: true,
    });
  if (gray4PreviewError) {
    throw new Error(
      `gray4 preview upload failed: ${gray4PreviewError.message}`
    );
  }

  return {
    ...asset,
    image_id: rendered.imageId,
    display_path: displayPath,
    preview_path: previewPath,
    gray4_image_id: rendered.gray4ImageId,
    gray4_display_path: gray4DisplayPath,
    gray4_preview_path: gray4PreviewPath,
  };
}

async function processAssetList(
  problemId: string,
  assets: unknown
): Promise<{ changed: boolean; next: AssetRecord[] }> {
  if (!Array.isArray(assets)) return { changed: false, next: [] };
  let changed = false;
  const next: AssetRecord[] = [];
  for (const raw of assets as AssetRecord[]) {
    if (!needsDerivation(raw)) {
      if (typeof raw?.path === 'string') stats.skipped += 1;
      next.push(raw);
      continue;
    }
    try {
      const enriched = await deriveOne(raw);
      next.push(enriched ?? raw);
      changed = true;
      stats.rendered += 1;
      console.log(`  rendered ${raw.path}`);
    } catch (error) {
      stats.failed += 1;
      const detail =
        error instanceof EinkImageError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      console.warn(`  FAILED ${problemId} ${raw.path}: ${detail}`);
      next.push(raw);
    }
  }
  return { changed, next };
}

async function main(): Promise<void> {
  let from = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from('problems')
      .select('id, assets, solution_assets')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`problems query failed: ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      stats.scanned += 1;
      const assets = await processAssetList(row.id, row.assets);
      const solutionAssets = await processAssetList(
        row.id,
        row.solution_assets
      );
      if (!assets.changed && !solutionAssets.changed) continue;

      const patch: Record<string, unknown> = {};
      if (assets.changed) patch.assets = assets.next;
      if (solutionAssets.changed) patch.solution_assets = solutionAssets.next;
      const { error: updateError } = await supabase
        .from('problems')
        .update(patch)
        .eq('id', row.id);
      if (updateError) {
        stats.failed += 1;
        console.warn(`  FAILED update ${row.id}: ${updateError.message}`);
      }
    }

    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(
    `done: scanned=${stats.scanned} rendered=${stats.rendered} ` +
      `skipped=${stats.skipped} failed=${stats.failed}`
  );
  if (stats.failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

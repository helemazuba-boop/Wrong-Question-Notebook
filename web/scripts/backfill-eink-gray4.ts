// Idempotently adds the optional GRAY4 WQNI derivative to every existing note,
// problem and solution image. The legacy BW1 fields remain untouched.
//
// Run from web/ with Node >= 24 (native type stripping):
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     node scripts/backfill-eink-gray4.ts

import { createClient } from '@supabase/supabase-js';
import { EinkImageError, renderEinkImage } from '../lib/eink-image.ts';

const BUCKET = 'problem-uploads';
const PAGE_SIZE = 100;

interface AssetRecord {
  path?: unknown;
  kind?: unknown;
  image_id?: unknown;
  gray4_image_id?: unknown;
  gray4_display_path?: unknown;
  [key: string]: unknown;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !secretKey) {
  console.error('Supabase URL and secret key are required');
  process.exit(1);
}

const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const stats = { scanned: 0, rendered: 0, skipped: 0, failed: 0 };

function needsGray4(asset: AssetRecord): boolean {
  if (typeof asset.path !== 'string' || typeof asset.image_id !== 'string') {
    return false;
  }
  if (asset.kind === 'pdf' || asset.path.toLowerCase().endsWith('.pdf')) {
    return false;
  }
  return !(
    typeof asset.gray4_image_id === 'string' &&
    typeof asset.gray4_display_path === 'string'
  );
}

function derivedDirOf(originalPath: string): string {
  const slash = originalPath.lastIndexOf('/');
  return slash >= 0 ? `${originalPath.slice(0, slash)}/derived` : 'derived';
}

async function deriveOne(asset: AssetRecord): Promise<AssetRecord> {
  const originalPath = asset.path as string;
  const { data: blob, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(originalPath);
  if (downloadError || !blob) {
    throw new Error(`download failed: ${downloadError?.message ?? 'no blob'}`);
  }
  const rendered = await renderEinkImage(Buffer.from(await blob.arrayBuffer()));
  const displayPath = `${derivedDirOf(originalPath)}/${rendered.gray4ImageId}.gray4.wqni`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(displayPath, rendered.gray4Wqni, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: true,
    });
  if (uploadError) throw new Error(`upload failed: ${uploadError.message}`);
  return {
    ...asset,
    gray4_image_id: rendered.gray4ImageId,
    gray4_display_path: displayPath,
  };
}

async function enrichAssets(owner: string, value: unknown) {
  if (!Array.isArray(value)) return { changed: false, assets: value };
  let changed = false;
  const assets: AssetRecord[] = [];
  for (const raw of value as AssetRecord[]) {
    if (!needsGray4(raw)) {
      stats.skipped += 1;
      assets.push(raw);
      continue;
    }
    try {
      assets.push(await deriveOne(raw));
      stats.rendered += 1;
      changed = true;
    } catch (error) {
      stats.failed += 1;
      const detail =
        error instanceof EinkImageError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      console.warn(`FAILED ${owner} ${String(raw.path)}: ${detail}`);
      assets.push(raw);
    }
  }
  return { changed, assets };
}

async function backfillProblems() {
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: rows, error } = await supabase
      .from('problems')
      .select('id, assets, solution_assets, updated_at')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!rows?.length) break;
    for (const row of rows) {
      stats.scanned += 1;
      const problem = await enrichAssets(`problem:${row.id}`, row.assets);
      const solution = await enrichAssets(
        `solution:${row.id}`,
        row.solution_assets
      );
      if (!problem.changed && !solution.changed) continue;
      const patch: Record<string, unknown> = {};
      if (problem.changed) patch.assets = problem.assets;
      if (solution.changed) patch.solution_assets = solution.assets;
      let update = supabase.from('problems').update(patch).eq('id', row.id);
      if (row.updated_at) update = update.eq('updated_at', row.updated_at);
      const { data: updated, error: updateError } = await update
        .select('id')
        .maybeSingle();
      if (updateError || !updated) {
        stats.failed += 1;
        console.warn(
          `FAILED problem update ${row.id}: ${
            updateError?.message ?? 'concurrent update; retry the backfill'
          }`
        );
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
}

async function backfillNotes() {
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: rows, error } = await supabase
      .from('notebook_notes')
      .select('id, assets, revision')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!rows?.length) break;
    for (const row of rows) {
      stats.scanned += 1;
      const result = await enrichAssets(`note:${row.id}`, row.assets);
      if (!result.changed) continue;
      const { data: updated, error: updateError } = await supabase
        .from('notebook_notes')
        .update({ assets: result.assets })
        .eq('id', row.id)
        .eq('revision', row.revision)
        .select('id')
        .maybeSingle();
      if (updateError || !updated) {
        stats.failed += 1;
        console.warn(
          `FAILED note update ${row.id}: ${
            updateError?.message ?? 'concurrent update; retry the backfill'
          }`
        );
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
}

await backfillProblems();
await backfillNotes();
console.log(`done ${JSON.stringify(stats)}`);
if (stats.failed > 0) process.exitCode = 1;

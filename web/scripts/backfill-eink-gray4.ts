// Idempotently adds the optional GRAY4 WQNI derivative to every existing note,
// problem and solution image. The legacy BW1 fields remain untouched.
//
// Run from web/ with Node >= 24 (native type stripping):
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     node scripts/backfill-eink-gray4.ts

import { pathToFileURL } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { EinkImageError, renderEinkImage } from '../lib/eink-image.ts';

const BUCKET = 'problem-uploads';
const PAGE_SIZE = 100;
const SHA256_RE = /^[0-9a-f]{64}$/;

interface AssetRecord {
  path?: unknown;
  kind?: unknown;
  image_id?: unknown;
  display_path?: unknown;
  gray4_image_id?: unknown;
  gray4_display_path?: unknown;
  gray4_preview_path?: unknown;
  [key: string]: unknown;
}

let supabase: SupabaseClient<any>;
const stats = { scanned: 0, rendered: 0, skipped: 0, failed: 0 };

type ImageArtifact = {
  image_id: string;
  pixel_format: 'bw1' | 'gray4';
  storage_path: string;
};

export function imageArtifactsOf(assets: unknown): ImageArtifact[] {
  if (!Array.isArray(assets)) return [];
  const rows: ImageArtifact[] = [];
  for (const value of assets) {
    const asset = value as AssetRecord;
    if (
      typeof asset.image_id === 'string' &&
      SHA256_RE.test(asset.image_id) &&
      typeof asset.display_path === 'string' &&
      asset.display_path.length > 0
    ) {
      rows.push({
        image_id: asset.image_id,
        pixel_format: 'bw1',
        storage_path: asset.display_path,
      });
    }
    if (
      typeof asset.gray4_image_id === 'string' &&
      SHA256_RE.test(asset.gray4_image_id) &&
      typeof asset.gray4_display_path === 'string' &&
      asset.gray4_display_path.length > 0
    ) {
      rows.push({
        image_id: asset.gray4_image_id,
        pixel_format: 'gray4',
        storage_path: asset.gray4_display_path,
      });
    }
  }
  return rows;
}

export async function registerBackfilledDeviceImageArtifacts(
  client: SupabaseClient<any>,
  userId: string,
  assetGroups: unknown[]
): Promise<void> {
  const unique = new Map(
    assetGroups
      .flatMap(imageArtifactsOf)
      .map(row => [row.image_id, row] as const)
  );
  if (unique.size === 0) return;

  const immutableRows = [...unique.values()].map(row => ({
    ...row,
    storage_path: `user/${userId}/device-images/${row.pixel_format}/${row.image_id}.wqni`,
  }));
  const existingPaths = new Map<string, string>();
  for (let offset = 0; offset < immutableRows.length; offset += 100) {
    const ids = immutableRows
      .slice(offset, offset + 100)
      .map(row => row.image_id);
    const { data, error } = await client
      .from('device_image_artifacts')
      .select('image_id, storage_path')
      .eq('user_id', userId)
      .in('image_id', ids);
    if (error) throw new Error(`artifact lookup failed: ${error.message}`);
    for (const row of data || []) {
      existingPaths.set(row.image_id, row.storage_path);
    }
  }

  const copyOne = async (row: (typeof immutableRows)[number]) => {
    const source = unique.get(row.image_id)?.storage_path;
    if (
      !source ||
      source === row.storage_path ||
      existingPaths.get(row.image_id) === row.storage_path
    ) {
      return;
    }
    const { error } = await client.storage
      .from(BUCKET)
      .copy(source, row.storage_path);
    if (error && !/already exists|duplicate/i.test(error.message)) {
      throw new Error(`artifact copy failed: ${error.message}`);
    }
  };
  for (let offset = 0; offset < immutableRows.length; offset += 8) {
    await Promise.all(immutableRows.slice(offset, offset + 8).map(copyOne));
  }

  const now = new Date().toISOString();
  const { error } = await client.from('device_image_artifacts').upsert(
    immutableRows.map(row => ({
      user_id: userId,
      ...row,
      last_seen_at: now,
    })),
    { onConflict: 'user_id,image_id' }
  );
  if (error) throw new Error(`artifact upsert failed: ${error.message}`);
}

function needsGray4(asset: AssetRecord): boolean {
  if (typeof asset.path !== 'string' || typeof asset.image_id !== 'string') {
    return false;
  }
  if (asset.kind === 'pdf' || asset.path.toLowerCase().endsWith('.pdf')) {
    return false;
  }
  return !(
    typeof asset.gray4_image_id === 'string' &&
    typeof asset.gray4_display_path === 'string' &&
    typeof asset.gray4_preview_path === 'string'
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
  const base = `${derivedDirOf(originalPath)}/${rendered.gray4ImageId}.gray4`;
  const displayPath = `${base}.wqni`;
  const previewPath = `${base}.png`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(displayPath, rendered.gray4Wqni, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: true,
    });
  if (uploadError) throw new Error(`upload failed: ${uploadError.message}`);
  const { error: previewError } = await supabase.storage
    .from(BUCKET)
    .upload(previewPath, rendered.gray4Preview, {
      contentType: 'image/png',
      cacheControl: '3600',
      upsert: true,
    });
  if (previewError) {
    throw new Error(`gray4 preview upload failed: ${previewError.message}`);
  }
  return {
    ...asset,
    gray4_image_id: rendered.gray4ImageId,
    gray4_display_path: displayPath,
    gray4_preview_path: previewPath,
  };
}

async function registerRowArtifacts(
  owner: string,
  userId: string,
  assetGroups: unknown[]
): Promise<void> {
  try {
    await registerBackfilledDeviceImageArtifacts(supabase, userId, assetGroups);
  } catch (error) {
    stats.failed += 1;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`FAILED ${owner} artifact registration: ${detail}`);
  }
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
      .select('id, user_id, assets, solution_assets, updated_at')
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
      if (!problem.changed && !solution.changed) {
        await registerRowArtifacts(`problem:${row.id}`, row.user_id, [
          problem.assets,
          solution.assets,
        ]);
        continue;
      }
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
      } else {
        await registerRowArtifacts(`problem:${row.id}`, row.user_id, [
          problem.assets,
          solution.assets,
        ]);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
}

async function backfillNotes() {
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: rows, error } = await supabase
      .from('notebook_notes')
      .select('id, user_id, assets, revision')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!rows?.length) break;
    for (const row of rows) {
      stats.scanned += 1;
      const result = await enrichAssets(`note:${row.id}`, row.assets);
      if (!result.changed) {
        await registerRowArtifacts(`note:${row.id}`, row.user_id, [
          result.assets,
        ]);
        continue;
      }
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
      } else {
        await registerRowArtifacts(`note:${row.id}`, row.user_id, [
          result.assets,
        ]);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secretKey) {
    throw new Error('Supabase URL and secret key are required');
  }
  supabase = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await backfillProblems();
  await backfillNotes();
  console.log(`done ${JSON.stringify(stats)}`);
  if (stats.failed > 0) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

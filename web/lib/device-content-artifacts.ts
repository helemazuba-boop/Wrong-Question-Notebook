import type { SupabaseClient } from '@supabase/supabase-js';
import { FILE_CONSTANTS } from '@/lib/constants';

const BUCKET = FILE_CONSTANTS.STORAGE.BUCKET;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class DeviceContentArtifactError extends Error {
  constructor(
    public readonly code:
      'artifact_not_found' | 'artifact_storage_error' | 'invalid_artifact',
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'DeviceContentArtifactError';
  }
}

export type DevicePackDomain = 'note_packs' | 'problem_packs';

export async function materializeDevicePackArtifact(input: {
  supabase: SupabaseClient<any>;
  userId: string;
  domain: DevicePackDomain;
  logicalId: string;
  revision: number;
  sha256: string;
  body: string;
}): Promise<string> {
  const { supabase, userId, domain, logicalId, revision, sha256, body } = input;
  if (!SHA256_RE.test(sha256)) {
    throw new DeviceContentArtifactError(
      'invalid_artifact',
      'Invalid pack hash',
      500
    );
  }
  const storagePath = `user/${userId}/device-packs/${domain}/${logicalId}/${sha256}.jsonl`;
  const bytes = Buffer.from(body, 'utf8');
  const { data: existing, error: lookupError } = await supabase
    .from('device_pack_artifacts')
    .select('storage_path')
    .eq('user_id', userId)
    .eq('domain', domain)
    .eq('logical_id', logicalId)
    .eq('sha256', sha256)
    .maybeSingle();
  if (lookupError) {
    throw new DeviceContentArtifactError(
      'artifact_storage_error',
      lookupError.message,
      500
    );
  }
  if (!existing) {
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, {
        contentType: 'application/x-ndjson',
        cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
        upsert: false,
      });
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) {
      throw new DeviceContentArtifactError(
        'artifact_storage_error',
        uploadError.message,
        500
      );
    }
  }
  const { error: recordError } = await supabase
    .from('device_pack_artifacts')
    .upsert(
      {
        user_id: userId,
        domain,
        logical_id: logicalId,
        revision,
        sha256,
        storage_path: existing?.storage_path ?? storagePath,
        byte_size: bytes.length,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,domain,logical_id,sha256' }
    );
  if (recordError) {
    throw new DeviceContentArtifactError(
      'artifact_storage_error',
      recordError.message,
      500
    );
  }
  return existing?.storage_path ?? storagePath;
}

type ImageArtifact = {
  image_id: string;
  display_path: string;
  gray4_image_id?: string;
  gray4_display_path?: string;
};

function imageArtifactsOf(assets: unknown): Array<{
  image_id: string;
  pixel_format: 'bw1' | 'gray4';
  storage_path: string;
}> {
  if (!Array.isArray(assets)) return [];
  const rows: Array<{
    image_id: string;
    pixel_format: 'bw1' | 'gray4';
    storage_path: string;
  }> = [];
  for (const value of assets) {
    const asset = value as Partial<ImageArtifact>;
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

export async function registerDeviceImageArtifacts(
  supabase: SupabaseClient<any>,
  userId: string,
  assetGroups: unknown[]
): Promise<void> {
  const unique = new Map(
    assetGroups
      .flatMap(imageArtifactsOf)
      .map(row => [row.image_id, row] as const)
  );
  if (unique.size === 0) return;

  // Attachment cleanup owns the source `derived/` directory and may remove
  // those objects after a note/problem is edited. A device pack, however, is
  // an immutable snapshot and can keep referencing the old image id. Copy
  // every referenced WQNI into a content-addressed device namespace before
  // publishing the lookup row so detach/reorder cannot invalidate an already
  // issued pack.
  const immutableRows = [...unique.values()].map(row => ({
    ...row,
    storage_path: `user/${userId}/device-images/${row.pixel_format}/${row.image_id}.wqni`,
  }));
  const existingPaths = new Map<string, string>();
  for (let offset = 0; offset < immutableRows.length; offset += 100) {
    const ids = immutableRows
      .slice(offset, offset + 100)
      .map(row => row.image_id);
    const { data, error } = await supabase
      .from('device_image_artifacts')
      .select('image_id, storage_path')
      .eq('user_id', userId)
      .in('image_id', ids);
    if (error) {
      throw new DeviceContentArtifactError(
        'artifact_storage_error',
        error.message,
        500
      );
    }
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
    const { error } = await supabase.storage
      .from(BUCKET)
      .copy(source, row.storage_path);
    if (error && !/already exists|duplicate/i.test(error.message)) {
      throw new DeviceContentArtifactError(
        'artifact_storage_error',
        error.message,
        500
      );
    }
  };
  for (let offset = 0; offset < immutableRows.length; offset += 8) {
    await Promise.all(immutableRows.slice(offset, offset + 8).map(copyOne));
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from('device_image_artifacts').upsert(
    immutableRows.map(row => ({
      user_id: userId,
      ...row,
      last_seen_at: now,
    })),
    { onConflict: 'user_id,image_id' }
  );
  if (error) {
    throw new DeviceContentArtifactError(
      'artifact_storage_error',
      error.message,
      500
    );
  }
}

export async function loadDevicePackArtifact(input: {
  supabase: SupabaseClient<any>;
  userId: string;
  domain: DevicePackDomain;
  logicalId: string;
  sha256: string;
}): Promise<{ body: ArrayBuffer; revision: number; byteSize: number }> {
  const { supabase, userId, domain, logicalId, sha256 } = input;
  if (!SHA256_RE.test(sha256)) {
    throw new DeviceContentArtifactError(
      'invalid_artifact',
      'Invalid pack hash',
      400
    );
  }
  const { data, error } = await supabase
    .from('device_pack_artifacts')
    .select('storage_path, revision, byte_size')
    .eq('user_id', userId)
    .eq('domain', domain)
    .eq('logical_id', logicalId)
    .eq('sha256', sha256)
    .maybeSingle();
  if (error) {
    throw new DeviceContentArtifactError(
      'artifact_storage_error',
      error.message,
      500
    );
  }
  if (!data) {
    throw new DeviceContentArtifactError(
      'artifact_not_found',
      'Pack snapshot expired; refresh the manifest',
      410
    );
  }
  const { data: blob, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(data.storage_path);
  if (downloadError || !blob) {
    throw new DeviceContentArtifactError(
      'artifact_not_found',
      'Pack artifact is unavailable; refresh the manifest',
      410
    );
  }
  return {
    body: await blob.arrayBuffer(),
    revision: Number(data.revision),
    byteSize: Number(data.byte_size),
  };
}

export async function loadDeviceImageArtifact(input: {
  supabase: SupabaseClient<any>;
  userId: string;
  imageId: string;
}): Promise<{ body: ArrayBuffer; pixelFormat: 'bw1' | 'gray4' }> {
  const { supabase, userId, imageId } = input;
  if (!SHA256_RE.test(imageId)) {
    throw new DeviceContentArtifactError(
      'invalid_artifact',
      'Invalid image id',
      400
    );
  }
  const { data, error } = await supabase
    .from('device_image_artifacts')
    .select('storage_path, pixel_format')
    .eq('user_id', userId)
    .eq('image_id', imageId)
    .maybeSingle();
  if (error) {
    throw new DeviceContentArtifactError(
      'artifact_storage_error',
      error.message,
      500
    );
  }
  if (!data) {
    throw new DeviceContentArtifactError(
      'artifact_not_found',
      'Image artifact not found',
      404
    );
  }
  const { data: blob, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(data.storage_path);
  if (downloadError || !blob) {
    throw new DeviceContentArtifactError(
      'artifact_not_found',
      'Image artifact not found',
      404
    );
  }
  return {
    body: await blob.arrayBuffer(),
    pixelFormat: data.pixel_format as 'bw1' | 'gray4',
  };
}

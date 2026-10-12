import 'server-only';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createTar } from 'tar';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accountIsActive } from '@/lib/supabase/account-status';

export type AccountDataJob = {
  id: string;
  user_id: string;
  kind: 'export' | 'delete';
  status: string;
  attempts: number;
  lease_id: string;
  archive_path: string | null;
  expires_at: string | null;
};
type StorageObject = { bucket: string; path: string };
const EXPORT_BUCKET = 'account-exports';
export function recentlyAuthenticated(
  claims: Record<string, unknown>,
  now = Date.now()
): boolean {
  if (!Array.isArray(claims.amr)) return false;
  return claims.amr.some(
    value =>
      value &&
      typeof value.timestamp === 'number' &&
      ['password', 'oauth', 'otp', 'totp', 'sso/saml', 'sso'].includes(
        value.method
      ) &&
      value.timestamp * 1000 <= now + 30000 &&
      value.timestamp * 1000 >= now - 5 * 60000
  );
}
export function safeStoragePath(path: string): boolean {
  return (
    !!path &&
    !path.includes('\\') &&
    ![...path].some(c => c.charCodeAt(0) < 32) &&
    path
      .split('/')
      .every(segment => !!segment && segment !== '.' && segment !== '..')
  );
}
function assetPaths(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value))
    for (const entry of value) assetPaths(entry, result);
  else if (value && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === 'string' &&
        [
          'path',
          'display_path',
          'preview_path',
          'gray4_display_path',
          'gray4_preview_path',
        ].includes(key) &&
        safeStoragePath(entry)
      )
        result.add(entry);
      else if (entry && typeof entry === 'object') assetPaths(entry, result);
    }
  return result;
}
async function objects(
  client: SupabaseClient<any>,
  userId: string
): Promise<StorageObject[]> {
  const { data, error } = await client.rpc('account_storage_objects', {
    p_user_id: userId,
  });
  if (error || !Array.isArray(data))
    throw new Error('Account storage inventory failed');
  for (const object of data)
    if (
      typeof object.bucket !== 'string' ||
      typeof object.path !== 'string' ||
      !safeStoragePath(object.path) ||
      !safeStoragePath(object.bucket)
    )
      throw new Error('Invalid storage inventory');
  return data;
}
async function renew(client: SupabaseClient<any>, job: AccountDataJob) {
  const { data, error } = await client
    .from('account_data_jobs')
    .update({ lease_until: new Date(Date.now() + 10 * 60000).toISOString() })
    .eq('id', job.id)
    .eq('lease_id', job.lease_id)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (error || !data) throw new Error('Account job lease lost');
}
export async function exportAccount(
  client: SupabaseClient<any>,
  job: AccountDataJob
): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'wqn-export-'));
  try {
    const { data, error } = await client.rpc('export_account_data', {
      p_user_id: job.user_id,
    });
    if (error || !data || typeof data !== 'object')
      throw new Error('Account data snapshot failed');
    const { data: auth, error: authError } =
      await client.auth.admin.getUserById(job.user_id);
    if (authError || !auth.user)
      throw new Error('Account identity export failed');
    await writeFile(
      join(folder, 'data.json'),
      JSON.stringify(
        {
          format: 'wqn-account-export-v1',
          generated_at: new Date().toISOString(),
          identity: {
            id: auth.user.id,
            email: auth.user.email,
            created_at: auth.user.created_at,
            providers: auth.user.identities?.map(identity => identity.provider),
          },
          tables: data,
        },
        null,
        2
      )
    );
    const files = (await objects(client, job.user_id)).filter(
      object => object.bucket !== EXPORT_BUCKET
    );
    const ownPaths = new Set(
      files
        .filter(object => object.bucket === 'problem-uploads')
        .map(object => object.path)
    );
    const externalReferences = [...assetPaths(data)].filter(
      path => !ownPaths.has(path)
    );
    await writeFile(
      join(folder, 'external-asset-references.json'),
      JSON.stringify(externalReferences, null, 2)
    );
    const manifest: Array<StorageObject & { archive_path: string }> = [];
    let bytes = 0;
    for (const object of files) {
      await renew(client, job);
      const { data: blob, error: downloadError } = await client.storage
        .from(object.bucket)
        .download(object.path);
      if (downloadError || !blob)
        throw new Error('Account attachment download failed');
      bytes += blob.size;
      // Fail explicitly rather than publish a truncated or incomplete export.
      if (bytes > 512 * 1024 * 1024)
        throw new Error(
          'Account export exceeds the configured archive capacity'
        );
      const archivePath = `assets/${object.bucket}/${object.path}`;
      await mkdir(join(folder, archivePath, '..'), { recursive: true });
      await writeFile(
        join(folder, archivePath),
        Buffer.from(await blob.arrayBuffer())
      );
      manifest.push({ ...object, archive_path: archivePath });
    }
    await writeFile(
      join(folder, 'attachments.json'),
      JSON.stringify(manifest, null, 2)
    );
    const archive = join(folder, 'account.tar.gz');
    await createTar(
      { cwd: folder, file: archive, gzip: true, portable: true },
      [
        'data.json',
        'attachments.json',
        'external-asset-references.json',
        ...(manifest.length ? ['assets'] : []),
      ]
    );
    if ((await stat(archive)).size > 512 * 1024 * 1024)
      throw new Error('Account export exceeds the configured archive capacity');
    if (!(await accountIsActive(client, job.user_id)))
      throw new Error('Account is disabled');
    await renew(client, job);
    const path = `${job.user_id}/${job.id}.tar.gz`;
    const { error: uploadError } = await client.storage
      .from(EXPORT_BUCKET)
      .upload(path, createReadStream(archive), {
        contentType: 'application/gzip',
        upsert: true,
      });
    if (uploadError) throw new Error('Account archive upload failed');
    return path;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
export async function deleteAccount(
  client: SupabaseClient<any>,
  job: AccountDataJob
) {
  const files = await objects(client, job.user_id);
  for (const object of files) {
    await renew(client, job);
    if (object.bucket === 'problem-uploads') {
      const { data: recipients, error } = await client.rpc(
        'foreign_account_asset_owners',
        { p_user_id: job.user_id, p_path: object.path }
      );
      if (error) throw new Error('Copied attachment lookup failed');
      for (const recipient of recipients ?? []) {
        const target = `user/${recipient}/retained/${createHash('sha256').update(object.path).digest('hex')}`;
        const { error: copyError } = await client.storage
          .from(object.bucket)
          .copy(object.path, target);
        if (copyError && !/already exists|duplicate/i.test(copyError.message))
          throw new Error('Copied attachment preservation failed');
        const result = await client.rpc('rehome_account_asset', {
          p_owner_id: job.user_id,
          p_recipient_id: recipient,
          p_old: object.path,
          p_new: target,
        });
        if (result.error)
          throw new Error('Copied attachment reference update failed');
      }
    }
    const { error: removeError } = await client.storage
      .from(object.bucket)
      .remove([object.path]);
    if (removeError) throw new Error('Account attachment deletion failed');
  }
  await renew(client, job);
  const prepared = await client.rpc('prepare_account_identity_deletion', {
    p_user_id: job.user_id,
  });
  if (prepared.error) throw new Error('Owned module deletion failed');
  // Global administrative settings remain; remove the departing editor FK.
  const settings = await client
    .from('admin_settings')
    .update({ updated_by: null })
    .eq('updated_by', job.user_id);
  if (settings.error)
    throw new Error('Administrative attribution cleanup failed');
  const claims = await client
    .from('device_claims')
    .delete()
    .eq('approved_by', job.user_id);
  if (claims.error) throw new Error('Device credential cleanup failed');
  const { error } = await client.auth.admin.deleteUser(job.user_id);
  if (error && error.code !== 'user_not_found')
    throw new Error('Account identity deletion failed');
}
export async function processAccountDataJobs(client: SupabaseClient<any>) {
  const { data: jobs, error } = await client.rpc('claim_account_data_job');
  if (error) throw new Error('Account job claim failed');
  const job = jobs?.[0] as AccountDataJob | undefined;
  if (!job) return { processed: 0 };
  let patch: Record<string, unknown>;
  try {
    const archivePath =
      job.kind === 'export' ? await exportAccount(client, job) : null;
    if (job.kind === 'delete') await deleteAccount(client, job);
    patch = {
      status: 'completed',
      archive_path: archivePath,
      completed_at: new Date().toISOString(),
      expires_at:
        job.kind === 'export'
          ? new Date(Date.now() + 7 * 86400000).toISOString()
          : null,
      last_error: null,
    };
  } catch (error) {
    // No tokens, URLs or attachment contents are stored in failure metadata.
    patch = {
      status:
        job.kind === 'delete'
          ? 'pending'
          : job.attempts >= 3
            ? 'failed'
            : 'pending',
      last_error:
        error instanceof Error
          ? error.message
          : 'Account operation unavailable',
      next_attempt_at: new Date(
        Date.now() + Math.min(3600000, 60000 * job.attempts)
      ).toISOString(),
    };
  }
  const saved = await client
    .from('account_data_jobs')
    .update({ ...patch, lease_until: null })
    .eq('id', job.id)
    .eq('lease_id', job.lease_id)
    .eq('status', 'running');
  if (saved.error) throw new Error('Account job result persistence failed');
  return { processed: 1, status: patch.status };
}
export async function cleanupExpiredAccountExports(
  client: SupabaseClient<any>
) {
  const { data, error } = await client
    .from('account_data_jobs')
    .select('id,archive_path')
    .eq('kind', 'export')
    .lt('expires_at', new Date().toISOString())
    .not('archive_path', 'is', null)
    .limit(50);
  if (error) throw new Error('Expired export lookup failed');
  for (const job of data ?? []) {
    const removed = await client.storage
      .from(EXPORT_BUCKET)
      .remove([job.archive_path]);
    if (removed.error) throw new Error('Expired export deletion failed');
    const saved = await client
      .from('account_data_jobs')
      .update({ archive_path: null })
      .eq('id', job.id);
    if (saved.error) throw new Error('Expired export state update failed');
  }
}

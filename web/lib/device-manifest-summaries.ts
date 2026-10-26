import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readAllQueryPages } from './query-pagination';
import {
  DeviceContentArtifactError,
  type DevicePackDomain,
} from './device-content-artifacts';

// Advance when pack bytes/rendering rules change without a source mutation.
const SUMMARY_FORMAT = 1;
const BUILD_CONCURRENCY = 2;
const summarySchema = z.object({
  logical_id: z.string(),
  source_key: z.string().regex(/^[0-9a-f]{64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pack_revision: z.number().int().nonnegative(),
  entry_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
});
export type DevicePackSummary = z.infer<typeof summarySchema>;
export interface ManifestSource {
  id: string;
  source_key: string;
}

export class DeviceManifestChanged extends Error {}

export async function guardManifestRead<T>(input: {
  supabase: SupabaseClient<any>;
  userId: string;
  domain: DevicePackDomain;
  revision: string;
  read: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.read();
  } catch (error) {
    if (
      (await readManifestRevision(
        input.supabase,
        input.userId,
        input.domain
      )) !== input.revision
    )
      throw new DeviceManifestChanged();
    throw error;
  }
}

export function packSourceKey(source: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([SUMMARY_FORMAT, source]))
    .digest('hex');
}

function failDatabase(message: string): never {
  throw new DeviceContentArtifactError('artifact_storage_error', message, 500);
}

export async function readManifestRevision(
  supabase: SupabaseClient<any>,
  userId: string,
  domain: DevicePackDomain
): Promise<string> {
  const { data, error } = await supabase
    .from('device_content_revisions')
    .select('revision')
    .eq('scope_key', userId)
    .eq('domain', domain)
    .maybeSingle();
  if (error) failDatabase(error.message);
  // An empty account may have no row yet. Its first content mutation creates it.
  const value = data?.revision ?? 0;
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    failDatabase('Manifest revision exceeds the safe numeric range');
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)))
    failDatabase('Invalid manifest source revision');
  return String(value);
}

/** Build only misses, with a request-wide bound, then publish derived pointers
 * only after the source revision is rechecked. A stale builder cannot label
 * mixed data as a valid new snapshot. Cached records contain no pack bodies. */
export async function resolveManifestSummaries<
  T extends ManifestSource,
>(input: {
  supabase: SupabaseClient<any>;
  userId: string;
  domain: DevicePackDomain;
  revision: string;
  sources: T[];
  build: (source: T) => Promise<{
    sha256: string;
    pack_revision: number;
    entry_count: number;
    byte_size: number;
    cacheable?: boolean;
  }>;
}): Promise<Array<{ source: T; pack: DevicePackSummary }>> {
  const { supabase, userId, domain, revision, sources, build } = input;
  const { data, error } = await guardManifestRead({
    supabase,
    userId,
    domain,
    revision,
    read: () =>
      readAllQueryPages((offset, limit) =>
        supabase
          .from('device_pack_summaries')
          .select(
            'logical_id,source_key,sha256,pack_revision,entry_count,byte_size'
          )
          .eq('user_id', userId)
          .eq('domain', domain)
          .order('logical_id', { ascending: true })
          .range(offset, offset + limit - 1)
      ),
  });
  if (error) failDatabase(error.message);
  const cached = new Map<string, DevicePackSummary>();
  for (const row of data ?? []) {
    const parsed = summarySchema.safeParse(row);
    // Invalid/old cache data is a miss; never publish it to a device.
    if (parsed.success) cached.set(parsed.data.logical_id, parsed.data);
  }
  const ready: Array<{ source: T; pack: DevicePackSummary }> = new Array(
    sources.length
  );
  const writes: DevicePackSummary[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= sources.length) return;
      const source = sources[index];
      try {
        let pack = cached.get(source.id);
        if (pack?.source_key !== source.source_key) {
          const built = await build(source);
          pack = summarySchema.parse({
            logical_id: source.id,
            source_key: source.source_key,
            sha256: built.sha256,
            pack_revision: built.pack_revision,
            entry_count: built.entry_count,
            byte_size: built.byte_size,
          });
          // Missing source images must be retried on later manifests: a restored
          // derivative can change the body even without a note/problem edit.
          if (built.cacheable !== false) writes.push(pack);
        }
        ready[index] = { source, pack };
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }
  // Wait for all started work before returning an error; don't detach uploads.
  await Promise.all(
    Array.from({ length: Math.min(BUILD_CONCURRENCY, sources.length) }, worker)
  );
  const currentRevision = await readManifestRevision(supabase, userId, domain);
  if (currentRevision !== revision) throw new DeviceManifestChanged();
  if (failed) throw failure;
  for (let offset = 0; offset < writes.length; offset += 100) {
    const { error } = await supabase.from('device_pack_summaries').upsert(
      writes
        .slice(offset, offset + 100)
        .map(row => ({ user_id: userId, domain, ...row })),
      { onConflict: 'user_id,domain,logical_id' }
    );
    if (error) failDatabase(error.message);
  }
  return ready;
}

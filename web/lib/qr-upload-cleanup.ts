import { FILE_CONSTANTS } from '@/lib/constants';
import { createServiceClient } from '@/lib/supabase-utils';

const TERMINAL_FILE_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;

/**
 * Delete expired QR-upload objects and their session rows in bounded batches.
 * Consumed files receive a grace period because the desktop fetch happens just
 * after the state transition to `consumed`.
 */
export async function cleanupStaleQrUploadSessions(
  batchSize = DEFAULT_BATCH_SIZE
): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 500);
  const serviceClient = createServiceClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const terminalCutoffIso = new Date(
    now.getTime() - TERMINAL_FILE_GRACE_MS
  ).toISOString();

  const { data: stale, error: selectError } = await serviceClient
    .from('qr_upload_sessions')
    .select('id, file_path')
    .or(
      `and(status.in.(pending,uploaded),expires_at.lt.${nowIso}),` +
        `and(status.in.(consumed,expired),expires_at.lt.${terminalCutoffIso})`
    )
    .order('expires_at', { ascending: true })
    .limit(limit);

  if (selectError) {
    throw new Error(
      `Failed to find stale QR upload sessions: ${selectError.message}`
    );
  }
  if (!stale || stale.length === 0) return 0;

  const paths = stale
    .map(row => row.file_path)
    .filter((path): path is string => Boolean(path));
  if (paths.length > 0) {
    const { error: storageError } = await serviceClient.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .remove(paths);
    if (storageError) {
      throw new Error(
        `Failed to remove stale QR upload objects: ${storageError.message}`
      );
    }
  }

  const { error: deleteError } = await serviceClient
    .from('qr_upload_sessions')
    .delete()
    .in(
      'id',
      stale.map(row => row.id)
    );
  if (deleteError) {
    throw new Error(
      `Failed to remove stale QR upload sessions: ${deleteError.message}`
    );
  }

  return stale.length;
}

export const QR_UPLOAD_CLEANUP_BATCH_SIZE = DEFAULT_BATCH_SIZE;

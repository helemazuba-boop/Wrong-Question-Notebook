import { createClient } from '@/lib/supabase/client';
import { FILE_CONSTANTS } from '../constants';

export async function getUserId() {
  const supabase = createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Not signed in');
  return data.user.id;
}

/**
 * role: "problem" | "solution"
 * problemId: the problem UUID (for new problems) or existing problem ID (for edits)
 * Upload path:
 *   user/{uid}/problems/{problemId}/{role}/{originalName}
 */
export async function uploadFiles(
  files: FileList | File[],
  role: 'problem' | 'solution',
  problemId: string
) {
  // Validate problemId to prevent invalid paths
  if (!problemId || problemId.trim() === '') {
    throw new Error('Problem ID is required for file upload');
  }

  // Validate problemId format (should be a valid UUID or non-empty string)
  if (problemId.includes('/') || problemId.includes('\\')) {
    throw new Error('Invalid Problem ID: contains path separators');
  }

  const supabase = createClient();
  const uid = await getUserId();
  const base = `user/${uid}/problems/${problemId}/${role}`;

  // Validate file sizes before upload
  const maxSize = FILE_CONSTANTS.MAX_FILE_SIZE.GENERAL;
  const oversizedFiles: string[] = [];

  Array.from(files).forEach(file => {
    if (file.size > maxSize) {
      oversizedFiles.push(file.name);
    }
  });

  if (oversizedFiles.length > 0) {
    throw new Error(
      `Files too large: ${oversizedFiles.join(', ')}. Maximum file size is 10MB.`
    );
  }

  const paths: string[] = [];
  for (const f of Array.from(files)) {
    const safeName = f.name.replace(/\s+/g, '_');
    const path = `${base}/${safeName}`;
    const { error } = await supabase.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .upload(path, f, {
        cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
        upsert: false,
      });
    if (error) throw error;
    paths.push(path);
  }
  return paths;
}

/**
 * Note image originals mirror the problem upload flow in the same bucket:
 *   user/{uid}/notes/{noteId}/{originalName}
 * The e-ink derivations are rendered server-side on attach under
 * user/{uid}/notes/{noteId}/derived/.
 */
export async function uploadNoteFiles(
  files: FileList | File[],
  noteId: string
) {
  if (!noteId || noteId.trim() === '') {
    throw new Error('Note ID is required for file upload');
  }
  if (noteId.includes('/') || noteId.includes('\\')) {
    throw new Error('Invalid Note ID: contains path separators');
  }

  const supabase = createClient();
  const uid = await getUserId();
  const base = `user/${uid}/notes/${noteId}`;

  const maxSize = FILE_CONSTANTS.MAX_FILE_SIZE.GENERAL;
  const oversized = Array.from(files).filter(f => f.size > maxSize);
  if (oversized.length > 0) {
    throw new Error(
      `Files too large: ${oversized.map(f => f.name).join(', ')}. Maximum file size is 10MB.`
    );
  }

  const paths: string[] = [];
  for (const f of Array.from(files)) {
    const safeName = f.name.replace(/\s+/g, '_');
    const path = `${base}/${safeName}`;
    const { error } = await supabase.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .upload(path, f, {
        cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
        // A retried attach (e.g. the derived-render step failed once) re-uploads
        // the same filename; overwriting the owner's own note original is the
        // desired outcome, while upsert:false turned every retry into a
        // duplicate-key 400.
        upsert: true,
      });
    if (error) throw error;
    paths.push(path);
  }
  return paths;
}

/** Create short-lived signed URLs for display; returns [{ path, url }] */
export async function signPaths(
  paths: string[],
  expiresInSec = FILE_CONSTANTS.STORAGE.SIGNED_URL_EXPIRES_IN
) {
  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from(FILE_CONSTANTS.STORAGE.BUCKET)
    .createSignedUrls(paths, expiresInSec);
  if (error) throw error;
  // data: [{ path, signedUrl, ... }]
  return (data ?? []).map((d: any) => ({
    path: d.path,
    url: d.signedUrl as string,
  }));
}

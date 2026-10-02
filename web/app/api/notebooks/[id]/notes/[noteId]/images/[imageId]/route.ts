import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  notebookErrorResponse,
  notebookSuccessResponse,
} from '@/lib/notebooks';
import { detachNoteImageAsset } from '@/lib/notebook-content-service';
import { deleteNoteImageObjects } from '@/lib/note-image-service';

// Detach an image from a note and remove its storage objects (original +
// derived WQNI + preview). The row mutation bumps the note revision, which
// advances the notebook pack sha so devices drop the image on next sync.

export async function DELETE(
  _req: Request,
  {
    params,
  }: { params: Promise<{ id: string; noteId: string; imageId: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id, noteId, imageId } = await params;
    const { note, removed } = await detachNoteImageAsset(
      supabase,
      user.id,
      id,
      noteId,
      imageId
    );
    // Storage cleanup is best-effort: the row is already consistent, and a
    // leaked object is preferable to a dangling asset reference.
    try {
      await deleteNoteImageObjects(removed, note.assets);
    } catch (error) {
      console.warn('note image storage cleanup failed:', error);
    }
    return notebookSuccessResponse({ note });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}

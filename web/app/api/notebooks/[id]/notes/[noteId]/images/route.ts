import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  notebookErrorResponse,
  notebookSuccessResponse,
  NotebookToolError,
} from '@/lib/notebooks';
import { attachNoteImageAsset } from '@/lib/notebook-content-service';
import {
  deleteNoteImageDerivedObjects,
  renderNoteImageDerivations,
} from '@/lib/note-image-service';
import { checkContentLimit } from '@/lib/content-limits';
import { CONTENT_LIMIT_CONSTANTS } from '@/lib/constants';

// Attach an already-uploaded original image to a note: render the e-ink
// derivations (WQNI + black/white preview) and append the asset record. The
// client uploads the original directly to storage first (same flow as
// problem assets), then calls this with the storage path.

const AttachImageSchema = z.object({
  path: z.string().min(1).max(512),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id, noteId } = await params;
    const parsed = AttachImageSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new NotebookToolError(
        'invalid_request',
        'Invalid image attach body',
        400
      );
    }

    // Derived objects add storage on top of the client upload; enforce the
    // same global storage budget as problem assets.
    const storageLimit = await checkContentLimit(
      user.id,
      CONTENT_LIMIT_CONSTANTS.RESOURCE_TYPES.STORAGE_BYTES
    );
    if (!storageLimit.allowed) {
      throw new NotebookToolError(
        'invalid_request',
        'Storage limit reached',
        403
      );
    }

    const asset = await renderNoteImageDerivations(
      user.id,
      noteId,
      parsed.data.path
    );
    let note;
    try {
      note = await attachNoteImageAsset(supabase, user.id, id, noteId, asset);
    } catch (error) {
      // The derivations are already in storage but the DB attach failed
      // (revision conflict, note gone, transient DB error): without cleanup
      // they would leak as unreferenced objects. The original stays so a
      // retry can re-render it.
      await deleteNoteImageDerivedObjects(asset).catch(() => undefined);
      throw error;
    }
    return notebookSuccessResponse({ note, asset });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}

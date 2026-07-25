-- Note image attachments V1: notes can carry up to 4 images, mirroring the
-- problem assets model (jsonb array on the row, objects in problem-uploads).
-- Each element: { path, image_id, display_path, preview_path } where image_id
-- is the SHA-256 of the derived WQNI e-ink bitmap the device downloads.
--
-- Additive and idempotent: re-running is a no-op.

alter table public.notebook_notes
  add column if not exists assets jsonb not null default '[]'::jsonb;

-- V1 hard cap: at most 4 images per note. Kept as a table constraint so the
-- limit holds regardless of which service path mutates the row.
alter table public.notebook_notes drop constraint if exists notebook_notes_assets_count_check;
alter table public.notebook_notes
  add constraint notebook_notes_assets_count_check
  check (jsonb_typeof(assets) = 'array' and jsonb_array_length(assets) <= 4);

-- Note image derivations (.wqni, application/octet-stream) live in the
-- problem-uploads bucket next to their originals, but the bucket's MIME
-- allowlist predates them and rejected every derived upload with 400.
-- Extend the allowlist; idempotent re-run safe.

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/octet-stream'
]
where id = 'problem-uploads';

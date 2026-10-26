# Device Manifest summary cache

Note/Problem v3 manifests retain their existing full-list SHA-256 snapshot,
offset cursor, page size and 410 restart contract. Download URLs still identify
immutable pack bytes. No firmware contract/schema change is required.

Apply `20261024000100_device_manifest_summaries.sql` before the new readers.
The source RPC and summary table are restricted to `service_role`; device
authentication and the active-account gate still run on every request.

## Read and build behavior

Each request reads the domain revision, lightweight owned source rows and
cached pack metadata. It builds misses with two workers, checks the domain
revision again, and only then stores derived pointers. A revision race retries
once on a fresh request; a pinned snapshot or another race returns 410.
Started builds settle before an error returns, including image copies/uploads.

The full manifest is assembled from those summaries before its snapshot hash
and response page are computed. A warm second page reads no note/problem
body, writes no summary, and performs no storage upload. The light source and
summary lists still scale with the number of containers; this is not a
constant-cost manifest or a current-page-only cold build.

Source/summary collections are explicitly paged, including when PostgREST
returns fewer rows than requested. Cache schema corruption is a miss, and
database failures fail the request rather than returning partial success.

## Invalidation

| Change | Behavior |
| --- | --- |
| Note content, assets, order, archive, deletion or move | Note-history head plus active note ID/revision/order fingerprint invalidates the affected notebook. |
| Notebook title | Refreshes the manifest title/hash while reusing its pack. |
| Container archive, deletion, owner transfer | Fresh owned listing removes it; derived pointer is pruned. Old immutable artifacts remain stored. |
| Problem, set or manual membership change | Domain revision invalidates Problem summaries conservatively across the owner. |
| Problem tag attachment/detachment | Added revision trigger invalidates smart-set membership. |
| Time-based smart filter | Rechecks only matching IDs through the same filter helper and cutoff as materialization; clock-only changes alter source identity. No TTL-stale membership is served. |
| Missing image derivative | Publishes usable text but leaves the summary uncached so a restored image is retried without requiring an edit. |
| Observed missing immutable download | Removes the unavailable metadata pointer on a storage 404. Pack FK/image invalidation triggers invalidate summaries; image generation also rejects a stale builder's late cache write. Temporary storage errors do not remove metadata. |

Image availability is observed during materialization/download, not polled on
every cache hit. Existing immutable copies survive source attachment cleanup.
BW1/GRAY4 fallback and snapshot image identities retain their existing rules.

Pack/image materialization updates `last_seen_at` at most once per 24 hours for
an otherwise identical pointer under a normal clock; a clock rollback resets
the timestamp once. Cache hits do not touch it. There is currently
no retention consumer of that field. Future GC must protect current summaries,
issued immutable snapshots and their images; age alone cannot authorize removal.

The cache key includes protocol schema and a generator format version. Bump
`SUMMARY_FORMAT` in `device-manifest-summaries.ts` when rendering/serialization
changes without a source mutation.

## Verification and rollback

`device-manifest-summaries.test.ts` exercises the real SDK and production
manifest/pack modules with isolated PostgREST/storage boundaries, a 137-row
ceiling, 1505 summaries, source races, images and time-dependent membership.
`supabase/tests/device_manifest_summaries.sql` checks the real PostgreSQL
source function, invalidation triggers and grants in a disposable schema copy.
Local query counts and EXPLAIN do not prove production latency or pool relief.

Rollback the reader/helper changes as one batch. The additive cache schema can
remain; the previous readers ignore it. Keep the pagination and security fixes,
account gates, original full-list snapshot/410 behavior and immutable artifacts.

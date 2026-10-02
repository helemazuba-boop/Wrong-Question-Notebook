# WQN Problem Study v1

This contract freezes device-side problem review over problem-set packs. A
错题本 on the device is one `problem_set` (user-curated: manual or smart), and
one set equals one deterministic JSONL pack mirroring the note-study wire
model. There is no session runtime: packs are reviewed in fixed order
(`fixed_pack_order_v1` in the manifest), and each verdict is a standalone
idempotent observation.

## Manifest and packs

`POST /api/esp32/v3/problems/manifest` relists sets by integer offset: the
request carries a numeric `cursor`, an optional `snapshot_id`, and `limit`; the
response echoes `cursor`, `has_more`, `revision`, and `snapshot_id`, with one
entry per set. Each entry names its pack — `pack_id`, `pack_revision`,
`schema_version` 1, `format` `jsonl`, `compression` `zlib`, `entry_count`,
`byte_size`, `sha256`, `download_url` — or `null` when the set has no built pack
yet. `GET /api/esp32/v3/problems/packs/{id}` and `.../{id}/{sha256}` serve the
body, and `/api/esp32/v3/problems/images/{problemId}/{kind}/{index}` serves the
e-ink image variants a row references.

One JSONL row is one problem:

- `problem_id`, `title`, `content_text`, `source`, `status`
  (`wrong` / `needs_review` / `mastered`), `is_optional`.
- `parts[]` — at most 10, each with `index`, `label`, `type`
  (`single_choice`, `multi_choice`, `fill_blank`, `short_answer`, `essay`),
  `full_marks`, `content_text`, `answer_text`, and — for choice parts — up to
  10 `choices[]` of `{id, text}`, already flattened to display-ready device
  text.
- `image_ids` / `solution_image_ids` — at most 8 SHA-256 ids each. The `gray4_`
  variants may carry `null` per slot, which tells the device to fall back to
  the full-tone image for that position.

## Observations

`POST /api/esp32/v3/problems/observations` carries `problem_id`, `action`
(`correct`, `hesitant`, `wrong`, `skip`), and `occurred_at`. The database RPC
`record_problem_review_v1` is the transaction boundary: the attempt insert, the
`problems.status` update, and the SM-2 schedule application commit together,
while `skip` records history only and touches no projection. The response
reports the resulting `status`, the `schedule` projection (`next_review_at`,
`interval_days`, `ease_factor`, `repetition_number`), `projection_applied`, and
`replayed` when the same actor request was already applied. Observations are
deduplicated by `user_id + device_id + request_id` (a web caller uses the zero
UUID in place of the device), and the ledger is append-only.

## Fixed limits

- At most 500 rows per pack, 4 MiB per uncompressed pack, and 65,535 bytes per
  JSONL row. A longer row makes the device reject the whole pack, so the
  builder keeps every row inside the bound.
- At most 100 sets per manifest page; the cursor is a numeric string.
- `request_id`: 16-64 URL-safe characters.
- Counters: `0..9007199254740991` (IEEE-754 exact integer range).

The authoritative schema and golden fixtures live in this directory. Firmware
pins a byte-identical copy of `problem-study-v1.schema.json` and its SHA-256
(`schema_sha256` in `manifest.json`), and the firmware build fails a configure
on a mismatch. `lib/__tests__/problem-study-v1.test.ts` pins the same digest
against the code constant, and the device hashes a pack with `mbedtls_sha256`,
refusing to scan or keep one whose digest does not match the manifest.

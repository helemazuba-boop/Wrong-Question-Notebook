# WQN Word Study v1 baseline

This contract freezes the shared word-learning semantics used by WQN and the
Note4 firmware. It is intentionally the first implementation of a reusable
study-session model; problems and notes may reuse the lifecycle later, but v1
accepts only the `word` domain.

## User semantics

Modes map to the internal model as follows:

| Visible mode | Purpose  | Ordering           |
| ------------ | -------- | ------------------ |
| `sequential` | `study`  | `sequential`       |
| `random`     | `study`  | `guided_random_v1` |
| `dictionary` | `lookup` | `lexicographic`    |
| `review`     | `study`  | `due_queue_v1`     |
| `intake`     | `study`  | `new_intake_v1`    |
| `shuffle`    | `study`  | `pure_random_v1`   |
| `mistakes`   | `study`  | `mistake_words_v1` |

`dictionary` is retired on the device (AI lookup replaces the letter grid) and
remains in the enum for compatibility. All modes render the same word card.
Looking a word up does not by itself mutate learning progress. Only explicit
`known` and `unknown` observations do so; `shown`, `revealed`, `skipped`, and
`looked_up` remain append-only history. Stopping or pausing a session is not a
failure and there is no compulsory daily target. Every session declares a count
bound and can contain at most 500 items.

`guided_random_v1` is deterministic for the same candidate snapshot and seed.
It places due learning words, due review words, new words, not-yet-due words,
and mastered words into successive buckets, then orders items inside a bucket
by FNV-1a-64 of `seed + NUL + item_id`, with `item_id` as the collision tie-break.
The product exposes this simply as “random”; no recommendation reason is sent
or rendered.

`due_queue_v1` is the review queue: the selection is words due before the end
of today (Asia/Shanghai day boundary), and the order is learning (including
relearning) first, then due review words by `due_at` ascending, with deck order
and `sort_index` as tie-breaks. No bucketing, no hashing.

`new_intake_v1` selects unlearned words in deck order. The session slice is
bounded by the request's `new_word_limit` minus the number of words already
introduced today, so the daily new-word budget is enforced server-side.

`pure_random_v1` and `mistake_words_v1` order the eligible set by the same
FNV-1a-64 shuffle; they differ in selection (`pure_random_v1` walks the whole
non-mastered scope, `mistake_words_v1` only words the user has marked unknown).

`sequential` accepts an optional `start_index`: the server skips that many
candidates of the ordered scope and returns the next window, letting the device
continue a book walk across sessions.

## Device-side composition

The server never learns about the local replay pool: the review entry interleaves
a word the user marked `unknown` back into its own queue after at least five
answered cards (at most twice per word), and each such card is an ordinary
observation with a fresh `sequence`. Replaying is therefore legal by
`session_id + sequence` alone, and a device that loses the pool on reboot simply
keeps the FSRS schedule the `unknown` observation already wrote.

Review completion requires both its queue and replay pool to be empty.
Sequential study completes only at the pinned whole-scope total, across all
local segments. Shuffle and mistakes remain user-controlled walks.

## Reliability and ownership

- `StudySession` pins the exact deck revision and pack SHA used to build it.
  A downloaded replacement is staged for the next session and never rewrites
  an active session.
- `StudyObservation` is append-only. The server deduplicates by
  `user_id + request_id` and serializes observations by
  `session_id + sequence`.
- Device timestamps are clamped to `2000-01-01..server now`. Every observation
  is retained, while only one newer than `last_reviewed_at` updates projections;
  the response reports this with `projection_applied`.
- Creating a session retires the previous active/paused session for the same
  actor and mode. Sessions expire after 30 days and then stop pinning packs.
- The database RPC is the transaction boundary for observation, progress, the
  legacy review-event projection, and the wrong-word projection.
- Firmware will use a bounded durable outbox in W4. W0-W3 establish the wire,
  database, content, and session prerequisites without switching the current
  UI submission path.
- Word packs contain immutable content only. Progress and session state are
  separate small records.

## Fixed limits

- JSON counters: `0..9007199254740991` (IEEE-754 exact integer range).
- At most 500 candidates per session, 32 decks, and 100 candidate IDs per transport page. The default page
  is 32; the Note4 keeps a bounded three-page rolling window.
- At most 10,000 entries per pack, 4 MiB per uncompressed pack, and 8 KiB per
  JSONL line on device.
- `request_id`: 16-64 URL-safe characters; seed: 1-64 URL-safe characters.

The authoritative schema and golden fixtures live in this directory. Firmware
pins a byte-identical copy and schema hash. Text tie-breakers use UTF-8 byte
order (`TextEncoder` on the cloud and `std::string`/`strcmp` semantics on the
firmware), not JavaScript UTF-16 code-unit order; the supplementary-plane edge
case is covered by both ordering tests.

## Long-sequence local sessions (authoritative wire definition)

Endpoints (both require v3 protocol headers, device auth, and the actor from
the authenticated context):

- `POST /api/esp32/v3/words/sessions/local`, max request body **131072 bytes**.
- `POST /api/esp32/v3/words/observations/batch`, max request body **65536 bytes**.
  Byte limits are enforced by counting streamed chunks, not by trusting
  `Content-Length`.

The local session request shape is deliberately minimal:

```
requestMetadata fields (request_id, boot_id, firmware_version, capabilities)
session_id: UUID, stable and generated by the device
scope: { deck_ids: 1..32 unique UUIDs, include_mastered: true }
seed: 1..64 [A-Za-z0-9_-]
start_index: integer 0..10000
snapshot: 1..32 packSnapshot objects, exact deck set equal to scope.deck_ids
items: 1..500 sessionItem objects, ordinal exactly 0..n-1, unique item_id
```

Legacy sequential requests omit `domain`, `mode`, `purpose`, `ordering`, and
`candidate_policy_version`. Their existing registration RPC and semantic
fingerprints stay unchanged. Shuffle requests additionally declare
`mode: "shuffle"`, `progress_revision`, and `scope.include_mastered: false`.
The server derives `word/study/pure_random_v1` and binds mode plus progress
revision into the v2 fingerprint. Other local modes and inconsistent scope
flags are rejected. Offline does not add a learning mode or a separate UI entry.
The server pins `optional_count` to `items.length`, retains ordinary
`candidate_items`, and never abandons other active sessions.

`snapshot[].content_revision` is device-declared advisory metadata: there is no
immutable historical revision table to validate it against. The trusted pin is
an exact historical READY `public.word_packs` row matching `deck_id`,
`pack_revision` and lowercase `sha256`; it does not have to be the deck's
current/latest pack. The server does not claim to validate content_revision.

The semantic fingerprint is SHA-256 over canonical JSON of only `session_id`,
`scope`, `seed`, `start_index`, `snapshot`, and `items` (plus a protocol tag).
It excludes `boot_id`, `firmware_version`, `capabilities`, transport
`request_id`, and all other metadata, so a reboot can retry the same stable
session. A changed immutable field yields `409 LOCAL_SESSION_CONFLICT`; a
foreign actor yields `409 LOCAL_SESSION_ACTOR_CONFLICT`. The response is
`{ ok, request_id, server_time_ms, data: { session_id, registered: true,
replayed: boolean } }`.

The batch request is `requestMetadata + session_id + observations[1..64]`.
Each observation is `{ request_id, sequence, item_id, action, mode,
occurred_at }` (no nested session ID): request IDs are unique and sequences are
consecutive ascending. The response `data` is `{ session_id, accepted, failure }`.
`accepted` contains only the durable input prefix, each with
`{ request_id, observation_id, sequence, replayed }`. `failure` is either
`null` or `{ request_id, sequence, code, retryable }`; processing stops at the
first semantic failure and no suffix is attempted. A reused `request_id` is
ACKed only when the existing observation's session, sequence, item, action,
mode and timestamp all match. Unknown DB errors roll back the whole batch and
return retryable `503`; only a true `401` clears the device token.

The C++ codec, worker paging, durable descriptor store and SyncService uploader
implement this wire shape. The device walks one offline round in <=500-item
segments with a <=96-item window; only whole-scope completion wraps to the
first word of a new round. The v1 200-byte observation format is unchanged,
with capacity 8192, enough for 7014 revealed/known facts over 3507 words.
This section and the byte-identical schema/fixtures are the field source of
truth for both implementations.


## Personal eligibility cache

`POST /api/esp32/v3/words/eligibility` requires the same authenticated device
context and a complete `snapshot` (1..32 exact historical READY pack pins).
The bounded request and response are at most 16 KiB. A read-only STABLE database
function validates device ownership and deck visibility, then returns one
complete snapshot: `progress_revision`, `item_ids_sha256`, `mastered_bitmap`.
This does not create learning observations or run a progress projector.

Items are sorted by UUID bytes. `item_ids_sha256` hashes their lowercase UUID
strings joined by a single LF, with no trailing LF. Each bitmap character is
`1` for a mastered word, `0` otherwise; 1..10000 bits are allowed. The firmware
checks the digest against its exact pinned item set before assigning any bit.
A same-size replacement set cannot reuse the old bitmap. Shared content packs
remain free of personal learning data.

The latest complete cache is reusable offline for its actor, pack pins and
scope. Before publishing the first random segment, the device stores a CRC
protected immutable per-round copy and pins its revision and seed. Every
segment sorts the same eligible set by the existing FNV-1a-64 policy before
slicing, so neither a reboot nor a background progress update reshuffles it.
New rounds may refresh the snapshot; individual known/unknown facts remain
outbox records and do not independently claim a word is mastered.

The firmware cache uses an independent `WQEL` v1 file family, bounded to 20 KiB
per file. It retains the full round UUID, pairing-token SHA binding (never the
token), scope generation, pack pins, progress revision, item digest and bitmap.
The current and backup shuffle slots retain their round caches. Garbage
collection validates an unreferenced cache before removing its family; unknown
or corrupt files stop cleanup. Missing/invalid cache does not imply an all-new
word set. Session v4 and 200-byte observation v1 encodings stay unchanged.

The Note4 home retains its original three rows and typography. Sequential
study uses the existing completion-page action, including an honest offline
queue-unavailable state; shuffle uses the existing random entry. Both share the
same worker/store/outbox lifecycle. Physical power-loss, SPIFFS pressure and
EPD acceptance remain device HIL requirements.

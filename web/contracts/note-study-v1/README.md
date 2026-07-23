# WQN Note Study v1 baseline

This contract freezes the blank-notebook study semantics shared by WQN and the
Note4 firmware. It reuses the same study-session runtime as `word-study-v1`
(session lifecycle, candidate window, snapshot pinning, durable observations,
request-id idempotency, monotonic sequence) but for the `note` domain only.

## gate-0 decision (locked)

The single explicit, durable user action for blank notebooks is **`read_completed`**
("显式读完" — the user confirms they finished reading a note). This is the action
whose durable outbox commit N4 validates. It is deliberately **not** a mastery
signal: reading a note never marks anything known/mastered.

- `read_completed` is only ever produced by an explicit user confirmation on the
  last screen of a note — never inferred from paging to the end.
- The runtime does not invent a button the product does not need; if the product
  later replaces the explicit action, this lock must be revised before N1 is
  re-frozen.

## User semantics

The visible entries are `顺序` (sequential) and `最近` (recent). Search is an AI
concern (MCP) and is intentionally absent from the device study modes.

| Visible mode | Purpose  | Ordering              |
| ------------ | -------- | --------------------- |
| `sequential` | `browse` | `sequential_note_v1`  |
| `recent`     | `browse` | `recently_updated_v1` |

Both modes browse the same note content. `sequential_note_v1` orders notes by
`(sort_index, id)` within notebook scope; `recently_updated_v1` orders by
`(updated_at desc, id)`. Recommendation is by last-viewed/created time only —
there is no review weight, no mastery, and no recommendation reason on the wire.

## Observations and projection

Allowed actions: `opened`, `read_completed`, `skipped`, `session_paused`.

Only `opened` and `read_completed` touch the read-state projection
(`note_read_state`): `opened` sets `last_opened_at`; `read_completed` sets
`last_completed_at` and increments `completed_count`. `skipped` and
`session_paused` are append-only history that still advance the session
sequence. The projection has exactly three fields:

```text
last_opened_at
last_completed_at
completed_count
```

The following are explicitly forbidden and cannot appear in a progress
projection: `mastered`, `known`/`unknown`, `status`, SM-2 / schedule fields, or
anything derived from open counts. The `mastery-projection` invalid fixture
guards this.

## Reliability and ownership

- `NoteSession` pins the exact notebook content revision and pack SHA used to
  build it. A downloaded replacement is staged for the next session and never
  rewrites an active session.
- `NoteObservation` is append-only. The server deduplicates by
  `user_id + device_id + request_id` and serializes observations by
  `session_id + sequence`.
- Creating a session retires the previous active/paused session for the same
  actor and mode; already-durable offline observations still drain. Sessions
  expire after 30 days.
- The database RPC `record_note_study_observation_v1` is the transaction
  boundary for the observation, the read-state projection, and the note change
  log.
- Content editing (Web/AI) never flows through the observation RPC; content
  commands and read observations are separate write paths.

## Fixed limits

- JSON counters: `0..9007199254740991` (IEEE-754 exact integer range).
- At most 500 candidates per session, 32 notebooks, and 100 candidate items per
  transport page. The default page is 32.
- At most 5,000 notes per pack, 4 MiB per uncompressed pack.
- `request_id`: 16-64 URL-safe characters; seed: 1-64 URL-safe characters.

The authoritative schema and golden fixtures live in this directory. Firmware
pins a byte-identical copy of `note-study-v1.schema.json` and its SHA-256
(`schema_sha256` in `manifest.json`). Text tie-breakers use UTF-8 byte order.

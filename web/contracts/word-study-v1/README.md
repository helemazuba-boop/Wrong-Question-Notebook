# WQN Word Study v1 baseline

This contract freezes the shared word-learning semantics used by WQN and the
Note4 firmware. It is intentionally the first implementation of a reusable
study-session model; problems and notes may reuse the lifecycle later, but v1
accepts only the `word` domain.

## User semantics

The visible entries remain `sequential`, `random`, and `dictionary`. They map
to the internal model as follows:

| Visible mode | Purpose  | Ordering           |
| ------------ | -------- | ------------------ |
| `sequential` | `study`  | `sequential`       |
| `random`     | `study`  | `guided_random_v1` |
| `dictionary` | `lookup` | `lexicographic`    |

All three modes render the same word card. Looking a word up does not by itself
mutate learning progress. Only explicit `known` and `unknown` observations do so;
`shown`, `revealed`, `skipped`, and `looked_up` remain append-only history.
Stopping or pausing a session is not a failure and there is no compulsory daily
target. A count, when supplied, is an optional session bound.

`guided_random_v1` is deterministic for the same candidate snapshot and seed.
It places due learning words, due review words, new words, not-yet-due words,
and mastered words into successive buckets, then orders items inside a bucket
by FNV-1a-64 of `seed + NUL + item_id`, with `item_id` as the collision tie-break.
The product exposes this simply as “random”; no recommendation reason is sent
or rendered.

## Reliability and ownership

- `StudySession` pins the exact deck revision and pack SHA used to build it.
  A downloaded replacement is staged for the next session and never rewrites
  an active session.
- `StudyObservation` is append-only. The server deduplicates by
  `user_id + request_id` and serializes observations by
  `session_id + sequence`.
- The database RPC is the transaction boundary for observation, progress, the
  legacy review-event projection, and the wrong-word projection.
- Firmware will use a bounded durable outbox in W4. W0-W3 establish the wire,
  database, content, and session prerequisites without switching the current
  UI submission path.
- Word packs contain immutable content only. Progress and session state are
  separate small records.

## Fixed limits

- JSON counters: `0..9007199254740991` (IEEE-754 exact integer range).
- At most 32 decks and 100 candidate IDs per transport page. The default page
  is 32; the Note4 keeps a bounded three-page rolling window.
- At most 10,000 entries per pack, 4 MiB per uncompressed pack, and 8 KiB per
  JSONL line on device.
- `request_id`: 16-64 URL-safe characters; seed: 1-64 URL-safe characters.

The authoritative schema and golden fixtures live in this directory. Firmware
pins a byte-identical copy and schema hash.

# WQN Device Control v3

This contract freezes the Note4 control plane: pairing, bootstrap, and
incremental sync. It is deliberately narrow — the control plane carries
configuration and content revisions, while problem, word, and note payloads
stay in their own contracts. The manifest also pins the media protocols that
did not change with protocol 3: AI streaming stays `v2-streaming` and realtime
audio stays `wqn-flash-v2`.

## Operations

| Route                              | Purpose                                  |
| ---------------------------------- | ---------------------------------------- |
| `POST /api/esp32/v3/claim/start`   | Start pairing, receive a display code    |
| `POST /api/esp32/v3/claim/poll`    | Poll the claim until it is approved      |
| `POST /api/esp32/v3/claim/approve` | Approve a display code (signed-in web)   |
| `POST /api/esp32/v3/bootstrap`     | Re-establish device identity after boot  |
| `POST /api/esp32/v3/sync`          | Pull configuration and content revisions |

Every device request carries `request_id`, `boot_id`, `firmware_version`, and
`capabilities` (up to 32 lowercase feature names). Every response is either
`{ok: true, request_id, server_time_ms, data}` or
`{ok: false, request_id, error: {code, retryable, retry_after_ms?}}`. `code` is
an upper-case token, `retryable` says whether the same request may be sent
again, and a retryable failure may carry `retry_after_ms` — rate limiting
answers 429 `RATE_LIMITED`, and an unusable idempotency store answers 503
`IDEMPOTENCY_UNAVAILABLE`.

## Pairing

`claim/start` publishes `hardware_id` plus a base64url SEC1 uncompressed P-256
public key, and receives an expiring `claim_id`, an 8-digit `display_code`, and
a poll interval. An authenticated web user submits that display code to
`claim/approve`; the next poll answers `status: approved` together with a
`sealed_credential` — the server's own P-256 public key, a salt, an IV, and the
ciphertext produced by P-256 ECDH → HKDF → AES-GCM. Only `approved` carries a
credential, and a pending or expired claim never does. The cloud stores only a
SHA-256 digest of the issued device token and rotates it through an
authenticated route (`/api/esp32/devices/{id}/rotate-token`), so a database
read cannot replay a device session.

## Idempotency

Request metadata is part of a request's identity. The cloud fingerprints the
canonical JSON of the body and keeps the outcome in
`esp32_request_idempotency` (endpoint, fingerprint, status, body, expiry) keyed
by `device_id + request_id`, so a retry — including one after a restart —
returns the original response instead of applying the write twice. Reusing a
`request_id` with a different endpoint or body answers 409 `REQUEST_ID_REUSED`,
which is not retryable. Rows derived from a device write use deterministic
UUIDv8 ids built from device, request, result index, and problem, so a replayed
write still points at the same attempt.

## Sync semantics

- `config_revision` and `sync_cursor` are monotonic counters. The device sends
  what it has and gets back what the cloud has; both stay inside the IEEE-754
  exact integer range.
- `summaries` is the cheap "is anything new" answer: `due_problem_ids` (at most
  100), `todo_count`, `word_due_count`, and `word_mistake_count`.
- `content_manifest` lists one entry per kind — `problems`, `todos`, `words`,
  `word_packs`, `note_packs`, `problem_packs` — each with that kind's current
  revision and an optional cursor. Packs and pages are then fetched from the
  contract that owns them.
- `configuration.auto_sync_interval_minutes` is one of `0`, `15`, `30`, `60`,
  `240`; `0` disables the device's automatic sync. A sync page is bounded by
  `limit` (1..100).

## Fixed limits

- JSON counters: `0..9007199254740991` (IEEE-754 exact integer range).
- `request_id` / `boot_id`: 16-64 URL-safe characters.
- `capabilities`: at most 32 unique names of 1-48 characters each.
- `firmware_version`: 1-64 characters. `retry_after_ms`: `0..86400000`.
- `poll_interval_ms`: `1000..30000`.

The authoritative schema and golden fixtures live in this directory. Firmware
pins a byte-identical copy of `device-control-v3.schema.json` and its SHA-256
(`schema_sha256` in `manifest.json`), and the firmware build fails a configure
on a mismatch. `lib/__tests__/device-control-v3.test.ts` pins the same digest
against the code constant and replays every fixture.

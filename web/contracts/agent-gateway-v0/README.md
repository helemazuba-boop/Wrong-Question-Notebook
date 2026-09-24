# WQN OpenCode Agent Gateway v0

This contract describes the **device-facing** surface of the gateway that lets a
paired WQN device (Note4) use a self-hosted [OpenCode](https://opencode.ai)
server as a remote coding agent. It is versioned `v0` because the device
protocol is deliberately small and may still grow; breaking device-visible
changes will be versioned `v1`.

The gateway is the only component that talks to OpenCode. OpenCode Basic Auth
credentials live in WQN server environment variables and never reach the device;
the device authenticates with its normal WQN device token.

## Where the authoritative copy lives

The firmware side of this contract is the authority for the wire vocabulary:
`contracts/agent-gateway-v0/` in the firmware repo
(`firmware/wqn-zectrix-note4/` in the maintainer's workspace,
[helemazuba-boop/wqn-zectrix-note4-firmware](https://github.com/helemazuba-boop/wqn-zectrix-note4-firmware)
upstream). Its `manifest.json` records the event list and the `schema_sha256` of
`agent-gateway-v0.schema.json`, and the firmware build verifies that hash on
every configure — so a schema change that is not mirrored here fails the
firmware build rather than drifting silently.

This file is the cloud's mirror: same routes, same events, plus the upstream
mapping that only the cloud knows. If the two disagree, the firmware copy wins
and this one is a bug.

## Endpoints (device → WQN)

All endpoints are under `/api/esp32/agent` and require device authentication.
Success answers `{"success": true, "data": …}`; failures answer
`{"success": false, "error": {"code", "message"}}`. The device only ever reads
`error.code` / `error.message`, so the `success` flag is additive rather than a
breaking change.

| Method | Path                        | Purpose                                                                  |
| ------ | --------------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/sessions`                 | List the binding's recent OpenCode sessions.                             |
| `POST` | `/sessions`                 | Create a new OpenCode session in the binding directory.                  |
| `POST` | `/agent/transcribe`         | Raw-PCM ASR, shared with the voice AI pipeline.                          |
| `POST` | `/sessions/{id}/run`        | Submit a prompt and stream the run (SSE).                                |
| `GET`  | `/sessions/{id}/events`     | Re-attach to a session's event stream without submitting a prompt (SSE). |
| `POST` | `/sessions/{id}/permission` | Reply to a pending permission ask.                                       |
| `GET`  | `/sessions/{id}/history`    | Backfill a session the device has not rendered yet.                      |
| `POST` | `/sessions/{id}/question`   | Answer a pending form/question ask with the chosen option value.         |
| `POST` | `/sessions/{id}/interrupt`  | Stop a submitted run; reports whether upstream actually interrupted one. |

Every action that takes a session id re-resolves ownership at action time
against the binding-scoped session list; an id outside the list is `404
session_not_found`. Session lists are bounded to the most recent
`OPENCODE_SESSION_LIST_LIMIT` (12) entries.

### Responses

- `GET /sessions/{id}/history` → `{data: {messages}}`, oldest-first, where each
  message is `{role: "user" | "assistant", text, thinking?, tools?}` and each
  tool is `{name, status: "running" | "done" | "error", preview?}`. Only the two
  roles the device renders are projected; upstream's turn-boundary and
  bookkeeping messages are dropped here rather than on the device.
- `POST /sessions/{id}/question` requires `{question_id, answer, confirmed: true}`.
  A missing confirmation is `422 confirmation_required`: the device must not
  answer a question it did not render.
- `POST /sessions/{id}/interrupt` → `{data: {interrupted}}`. A run that had
  already finished is a **success** with `interrupted: false`, not an error.

## Device SSE events (WQN → device)

| Event                   | Payload                                              | Meaning                                                       |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `agent.accepted`        | `{session_id}`                                       | The prompt was accepted by the upstream server.               |
| `agent.attached`        | `{session_id}`                                       | Observe stream connected; no prompt was sent.                 |
| `agent.status`          | `{session_id, status, attempt?, message?}`           | `busy`, `retry`, or `idle`. `idle` ends the stream.           |
| `agent.text.delta`      | `{session_id, delta}`                                | Incremental assistant text (≤ 2 KiB per frame).               |
| `agent.text`            | `{session_id, text}`                                 | Full assistant text snapshot (≤ 8 KiB; repair frames only).   |
| `agent.reasoning.delta` | `{session_id, delta}`                                | Incremental model reasoning (≤ 2 KiB per frame).              |
| `agent.reasoning`       | `{session_id, text}`                                 | Full reasoning snapshot (≤ 2 KiB; repair frames only).        |
| `agent.tool`            | `{session_id, tool, status, preview?}`               | Tool activity preview; `status` ∈ `running`, `done`, `error`. |
| `agent.permission`      | `{session_id, permission_id, type, title, preview?}` | OpenCode is waiting for approval.                             |
| `agent.question`        | `{session_id, question_id, title, options[]}`        | A form the device can answer; `options` ≤ 2 `{value, label}`. |
| `agent.error`           | `{session_id, message}`                              | Session-level failure.                                        |

`agent.reasoning*` is a **separate channel** from `agent.text*` and never feeds
the answer text: the device renders it as a thinking block, so a gateway bug
cannot make chain-of-thought look like the answer.

`agent.text` is deliberately conditional. It is emitted only when a delta was
lost (the bytes actually sent are shorter than the upstream part's accumulated
text), which is the only self-healing channel for a dropped delta and avoids
overwriting newer text the device already has. The same rule governs
`agent.reasoning`.

Stream termination is `agent.status {status: "idle"}` in every mode. Failures
emit `agent.error` **before** the idle so a failed run is not reported as a
success; an interrupted run never emits a success frame.

## How pending asks reach the device

OpenCode v2 has no permission or question _event_. Both are polled from the
upstream session state while the stream is open, gated from cheapest to most
precise:

1. `GET /session/active` — the target session and its spawned children must be
   in the active map, or the round is skipped with no further requests. This is
   also what stops an ask that was answered long ago from being re-armed after
   a reconnect.
2. `GET /session?parentID={id}` — re-read every round, because a subagent can
   be spawned mid-run.
3. `GET /session/{id}/permission` — a pending ask is deduped by id. The device
   holds **one** pending ask per kind, so a second ask is held back until the
   first is answered rather than overwriting it.
4. `GET /session/{id}/form`, then `GET /session/{id}/form/{formId}` for each
   unseen form — the list has no state, so only the detail read distinguishes
   `pending` from `answered` / `cancelled`. Answered and cancelled forms are
   recorded as seen and never re-armed.

A form whose single projectable field has more than two options — or none — is
**not** armed on the device: the option bar has two slots, and an unanswerable
prompt is worse than a clear instruction. Those degrade to
`agent.status {status: "busy", message: "…请在 OpenCode 端回答"}`.

The device never builds the upstream `answer` record. It sends the option value
it chose; the cloud resolves the form's field id and assembles
`{answer: {[fieldKey]: value}}`.

Timing: the poll interval is `WQN_OPENCODE_PENDING_POLL_MS` (default 2000 ms),
shared with the SSE heartbeat so a silent upstream still produces traffic every
~14 s. The initial poll runs only in observe mode; in run mode the first tick
happens 2 s in, so a freshly submitted run cannot arm the previous run's stale
ask.

### Permission replies

OpenCode blocks the run while a permission ask is pending. The device replies
through `POST /sessions/{id}/permission` with
`{permission_id, decision: "once" | "reject", confirmed: true}`. There is no
`always` decision: the device can only express a one-shot approval or a
rejection, and offering a third value it can never send is a dead surface. A
`reject` is forwarded with a fixed corrective message (`Rejected from WQN Note4`)
so the session continues instead of hard-failing with a rejection error.

## Gateway timing

- Idle timeout: the upstream event stream is aborted after
  `WQN_OPENCODE_EVENT_IDLE_TIMEOUT_MS` (default 300 s) without a byte; every
  received chunk resets it. OpenCode itself stays silent during long tool runs,
  so do not lower this below the longest acceptable silent wait.
- Absolute cap: `WQN_OPENCODE_EVENT_MAX_DURATION_MS` (default 30 min) bounds a
  whole attach regardless of activity.
- Observe mode ends as soon as the session is absent from `/session/active` and
  its upstream record carries a terminal `outcome`. Run mode deliberately does
  not use that rule: a run may be legitimately silent for minutes.
- A run that outlives its stream keeps executing on the OpenCode server; the
  device re-attaches with the observe endpoint and backfills through
  `/sessions/{id}/history`.

## Bounds

These are the device-side limits the cloud stays inside, not protocol
requirements. They exist because the device has a hard 16 KiB JSON response
ceiling and a 400×300 panel.

| Bound                                        | Value                                 |
| -------------------------------------------- | ------------------------------------- |
| JSON response body                           | 16 KiB (device hard limit)            |
| History response                             | ≤ 12 KiB, ≤ 24 messages, oldest-first |
| Single message text                          | 2 KiB                                 |
| Single thinking block                        | 2 KiB                                 |
| `agent.text`                                 | 8 KiB                                 |
| `agent.text.delta` / `agent.reasoning.delta` | 2 KiB per frame                       |
| Question options                             | ≤ 2                                   |
| Sessions listed                              | 12                                    |
| Prompt per run                               | 4 KiB                                 |

## Rate limits (per device id)

| Bucket                 | Limit     |
| ---------------------- | --------- |
| sessions (list/create) | 20 / min  |
| transcribe             | 10 / min  |
| run                    | 6 / 5 min |
| permission, events     | 20 / min  |

## Upstream mapping (cloud-only)

The device contract above is stable across OpenCode versions; this table is
what it currently maps onto in OpenCode **v2**. It is documentation, not
something the device may rely on.

| Gateway concern  | v2 upstream path                                                                 |
| ---------------- | -------------------------------------------------------------------------------- |
| Session list     | `GET /api/session?limit&order=desc&parentID=null&directory=`                     |
| Create session   | `POST /api/session` with `{location:{directory}, agent?, model?}`                |
| Submit prompt    | `POST /api/session/{id}/prompt` with `{text, delivery:"steer"}`                  |
| Event stream     | `GET /api/event`                                                                 |
| Permission list  | `GET /api/session/{id}/permission`                                               |
| Permission reply | `POST /api/session/{id}/permission/{requestID}/reply` with `{decision, message}` |
| Message history  | `GET /api/session/{id}/message?limit&order=desc`                                 |
| Question list    | `GET /api/session/{id}/form`                                                     |
| Question detail  | `GET /api/session/{id}/form/{formID}`                                            |
| Question reply   | `POST /api/session/{id}/form/{formID}/reply` with `{answer}`                     |
| Interrupt        | `POST /api/session/{id}/interrupt`                                               |
| Active sessions  | `GET /api/session/active`                                                        |
| Child sessions   | `GET /api/session?parentID={id}`                                                 |
| Session outcome  | `GET /api/session/{id}`                                                          |

Two upstream facts are load-bearing and easy to get wrong: every response is
wrapped in `{data}` (an unwrapped read is `invalid_response`, not an empty
list), and `order=updated.desc` is rejected with HTTP 400 — the only accepted
descending order is `desc`.

## Binding configuration

Server-side only. Either a per-user JSON map
(`WQN_OPENCODE_USER_BINDINGS_JSON`) or an allowlist plus a single global binding
(`WQN_OPENCODE_ALLOWED_USER_IDS`, `WQN_OPENCODE_SERVER_URL`,
`WQN_OPENCODE_DIRECTORY`, `WQN_OPENCODE_SERVER_USERNAME`,
`WQN_OPENCODE_SERVER_PASSWORD`, `WQN_OPENCODE_AGENT`,
`WQN_OPENCODE_PROVIDER_ID`, `WQN_OPENCODE_MODEL_ID`). Unconfigured or incomplete
bindings fail closed with `503 disabled`; users outside the allowlist get `403
forbidden`.

`WQN_OPENCODE_DIRECTORY` is the **only** tenant boundary and must be a string
the upstream server recognizes: a session's own `location.directory` is its
worktree, not the binding's startup directory, so comparing the two client-side
would drop every row. A misconfigured directory fails loudly (empty session
list, every session action `404`) rather than leaking another tenant's
sessions.

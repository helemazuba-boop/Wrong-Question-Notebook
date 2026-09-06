# WQN OpenCode Agent Gateway v0

This contract describes the device-facing gateway that lets a paired WQN
device (Note4) use a self-hosted [OpenCode](https://opencode.ai) server as a
remote coding agent. It is versioned `v0` because the device protocol is
deliberately small and may still grow; breaking device-visible changes will
be versioned `v1`.

The gateway is the only component that talks to OpenCode. OpenCode Basic Auth
credentials live in WQN server environment variables and never reach the
device; the device authenticates with its normal WQN device token.

## Endpoints (device → WQN)

All endpoints are under `/api/esp32/agent` and require device
authentication. Errors use the agent envelope
`{"success": false, "error": {"code", "message"}}`.

| Method | Path                        | Purpose                                                                  |
| ------ | --------------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/sessions`                 | List the binding's recent OpenCode sessions.                             |
| `POST` | `/sessions`                 | Create a new OpenCode session in the binding directory.                  |
| `POST` | `/agent/transcribe`         | Raw-PCM ASR, shared with the voice AI pipeline.                          |
| `POST` | `/sessions/{id}/run`        | Submit a prompt and stream the run (SSE).                                |
| `POST` | `/sessions/{id}/permission` | Reply to a pending permission ask.                                       |
| `GET`  | `/sessions/{id}/events`     | Re-attach to a session's event stream without submitting a prompt (SSE). |

Every action that takes a session id re-resolves ownership at action time
against the binding-scoped session list; an id outside the list is `404
session_not_found`. Session lists are bounded to the most recent
`OPENCODE_SESSION_LIST_LIMIT` (12) entries.

## Device SSE events (WQN → device)

| Event              | Payload                                              | Meaning                                             |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| `agent.accepted`   | `{session_id}`                                       | `prompt_async` was submitted.                       |
| `agent.attached`   | `{session_id}`                                       | Observe stream connected; no prompt was sent.       |
| `agent.status`     | `{session_id, status, attempt?, message?}`           | `busy`, `retry`, or `idle`. `idle` ends the stream. |
| `agent.text.delta` | `{session_id, delta}`                                | Incremental assistant text.                         |
| `agent.text`       | `{session_id, text}`                                 | Full assistant text snapshot (truncated at 8 KiB).  |
| `agent.tool`       | `{session_id, tool, status, preview?}`               | Tool activity preview.                              |
| `agent.permission` | `{session_id, permission_id, type, title, preview?}` | OpenCode is waiting for approval.                   |
| `agent.error`      | `{session_id, message}`                              | Session-level failure.                              |

Run mode swallows an `idle` that arrives before any activity so a stale
buffered idle cannot complete a run that has not started. Observe mode treats
the first session-scoped `idle` as "nothing is running" and closes.

SSE comments (`: keepalive`) are emitted at least every 15 seconds of upstream
silence so intermediate proxies do not reap idle connections. Device parsers
must discard comment lines.

## Permission semantics

OpenCode blocks the run while a permission ask is pending. The device replies
through `POST /sessions/{id}/permission` with
`{permission_id, decision: "once" | "reject", confirmed: true}`. A `reject`
is forwarded with a fixed corrective message (`Rejected from WQN Note4`) so
the session continues instead of hard-failing with `PermissionRejectedError`.
The gateway calls the modern OpenCode endpoint
`POST /permission/{requestID}/reply`.

## Gateway timing

- Idle timeout: the upstream event stream is aborted after
  `WQN_OPENCODE_EVENT_IDLE_TIMEOUT_MS` (default 300 s) without a byte; every
  received chunk resets it. OpenCode itself stays silent during long tool
  runs, so do not lower this below the longest acceptable silent wait.
- Absolute cap: `WQN_OPENCODE_EVENT_MAX_DURATION_MS` (default 30 min) bounds a
  whole attach regardless of activity.
- A run that outlives its stream keeps executing on the OpenCode server; the
  device re-attaches with the observe endpoint.

## Rate limits (per device id)

| Bucket                 | Limit     |
| ---------------------- | --------- |
| sessions (list/create) | 20 / min  |
| transcribe             | 10 / min  |
| run                    | 6 / 5 min |
| permission, events     | 20 / min  |

## Binding configuration

Server-side only. Either a per-user JSON map (`WQN_OPENCODE_USER_BINDINGS_JSON`)
or an allowlist plus a single global binding (`WQN_OPENCODE_ALLOWED_USER_IDS`,
`WQN_OPENCODE_SERVER_URL`, `WQN_OPENCODE_DIRECTORY`,
`WQN_OPENCODE_SERVER_USERNAME`, `WQN_OPENCODE_SERVER_PASSWORD`,
`WQN_OPENCODE_AGENT`, `WQN_OPENCODE_PROVIDER_ID`, `WQN_OPENCODE_MODEL_ID`).
Unconfigured or incomplete bindings fail closed with `503 disabled`; users
outside the allowlist get `403 forbidden`.

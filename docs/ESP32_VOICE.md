# ESP32 voice: wrong questions, new Notes and Todos

The approved voice update replaces eleven device tools with eight. STD/PRO
streaming, legacy chat and Flash use the same allow-list and executor. The
external MCP v2 surface keeps its 43 tools. Existing Word data, Web Word tools
and the device's independent Word learning page are retained; Word functions
are removed from the voice assistant only.

## Model-visible tools

| Task                   | Tools                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Browse wrong questions | `list_problem_sets`, `list_problem_set_problems`, `search_user_problems`, `get_problem_detail` |
| Save a new Note        | `create_notebook_note`                                                                         |
| Todos                  | `list_todos`, `create_todo`, `update_todo_status`                                              |

There is no voice tool for listing authorized notebooks, Word operations,
content updates, Problem review ratings or Word study observations. Removed
names are rejected at both advertisement and execution boundaries. Smart
collection counts/members and full Problem details reuse the v2 readers,
including printed options without official answers, math, answer provenance,
image completion state and a WQN URL. Image links are not presented as proof
that the voice model has seen an image.

## Context and dates

The server injects current time, account timezone, local date/weekday and
create-authorized notebook IDs/names/subjects. Archived or foreign notebooks
are excluded. One notebook may be selected directly; ambiguous targets require
the user to choose. The injected list is capped at 50 and explicitly marked
incomplete when larger. Current create permission is checked again inside the
write transaction.

STD/PRO receives a fresh snapshot before its ASR/chat pipeline. Legacy chat
loads it before LLM execution. Flash refreshes its snapshot before each user
response, using a body-signed internal `/api/esp32/ai/context` request. The
original turn anchor is retained through tool continuations. Cancelled or
closed responses cannot start after a delayed context request resolves.
Context failure does not silently start an ungrounded Flash response.

`create_todo` accepts the existing absolute ISO timestamps and new `due` /
`reminder` objects, mutually exclusive with the respective absolute fields:

```json
{
  "title": "复习数学",
  "due": { "date": "tomorrow" }
}
```

- `date`: `today`, `tomorrow`, `day_after_tomorrow` or `YYYY-MM-DD`.
- `time`: optional local `HH:mm`.
- `offset_minutes`: positive integer, mutually exclusive with `date`/`time`.
- A date-only due arrangement uses 23:59:59 on that local date.
- A reminder on a date requires an explicit time; no reminder is inferred
  from a due date. Missing time returns `reminder_time_required` before writes.
- Invalid calendar dates and nonexistent/ambiguous DST times are rejected.
- The account's stored timezone is authoritative. The existing UTC fallback
  applies to unset/invalid timezone values. Failed profile lookup is marked
  unavailable and cannot resolve a guessed local calendar.

## Durable voice writes

Tools do not need the model to invent operation IDs. STD/PRO derives them from
device, turn and tool-call IDs. Flash derives them from device and provider
call IDs and forwards its signed request ID to execution. The complete original
tool input is fingerprinted, including relative-time input. Prepared commands
retain the first resolved absolute time and original turn context.

`20261014000300_esp32_voice_operations.sql` extends the MCP operation storage
with a device credential and two service-only RPCs. It verifies the active
account/device binding, permits only Note creation, Todo creation and Todo
status actions, and commits business effects with a receipt in one transaction.
It reuses the five-minute lease and preparation/recovery mechanisms. Completed
receipts replay after the 24-hour recovery deadline. Faults roll back business
rows; a lost commit response is queried and an unverified outcome is reported
as unknown. Current notebook permission also gates returning a Note receipt.

The voice path does not mint PAT/OAuth tokens or expose owner approval RPCs.
The `{ok,display,data,action,error}` device tool envelope and existing audio
protocols remain compatible. Firmware changes are limited to Flash default
instructions; device clocks and provider credentials are not made authoritative.

Notes store the conversation source in `metadata.source_conversation_id`, not
as a table column. Flash emits firmware-compatible `tool.result` / `tool.error`
events. Transport failures after a write was sent report `unknown_outcome`;
they do not authorize another create call. See the
[2026-10-21 voice audit](VOICE_MCP_AUDIT_20261021.md) for the reproduced defects,
repair scope and the opt-in real PostgreSQL executor regression.

## Local validation

- Full Web suite: 1,553 passed, 1 skipped; 160 files passed, 2 skipped.
- Isolated PostgreSQL: 24 new voice assertions plus 70 original MCP v2
  assertions passed, including fault rollback and permission revocation.
- TypeScript, ESLint (0 errors / 164 existing warnings), translations,
  production Webpack build and client-bundle secret scan passed.
- Note4: existing `build-ai-local-s3` build completed with zero compiler
  warnings; M8 architecture ownership gate and CRLF-aware diff checks passed.

Host mocks and isolated database checks do not establish real provider,
production, or device acceptance. No device was flashed and no remote push or
deployment was performed. Unrelated existing serial-monitor edits in the
firmware checkout are excluded from this work's commit.

## Rollout / device acceptance

Apply the existing two MCP v2 migrations and then the new voice migration.
Release matching Web and realtime-proxy images together: Flash's context
endpoint and eight-tool prompt are shared across their package boundary.
Reconnect existing Flash sessions so cached tool declarations are replaced.
The matching Note4 firmware carries the revised default instructions; older
firmware can still use the cloud-owned tool surface and unchanged audio protocol.

On a real device verify STD/PRO and Flash: create a Todo saying "tomorrow",
clarify a date-only reminder, save a Note without a preliminary tool lookup,
browse manual and smart collections with pagination, read no-answer choices,
retry a lost write response, revoke notebook access, cross local midnight,
cancel during context refresh, and reconnect. Confirm removed Word/update tool
names never execute and only durable success is narrated as saved.

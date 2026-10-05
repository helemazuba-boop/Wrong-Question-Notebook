# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Problem worksheet printing**
  - Print the whole problem set, or tick individual problems inside it, straight from the review page. The print dialog carries a scope radio (current problem / whole set) and a checkbox list with select-all and a selected count; the plain subject-review route, whose list holds navigation data alone, stays single-problem rather than offering a half-working picker.
  - A worksheet is its own document now, not a state of the review screen. It is rendered into a portal on `<body>` and hidden on screen by a rule that sits _outside_ `@media print`, so the answer key and the solution text exist in exactly one place and nothing is left on screen. Print styling lives in its own file scoped under `.print-sheet`.
  - The three answer placements (end / below / none) are rendered by React state instead of a cross-product of CSS `[data-print-mode]` display rules. A bare Ctrl+P that never opens the dialog now prints the same worksheet — the placement is kept in an external store, so it survives a reload and follows the user across tabs.
  - Print styles declare `@page { size: A4; margin: 14mm 12mm }`, which matters because the Android print adapter is built with `NO_MARGINS` and the page margins were previously whatever the browser defaulted to.
  - Answer space scales with the part: choice parts need none (the option letters are the answer area), a written part gets one ruled line and an essay gets a block, instead of a single line that could not hold a written response.
  - The header carries the brand mark and the product's full name and nothing else. The name/class/date blanks a printed worksheet would normally open with were left out deliberately: they exist so a collected sheet can be attributed, and a sheet nobody can claim is worth less than one with less paper.

- **OpenCode session list reports which session is running**
  - `GET /api/esp32/agent/sessions` now reports each session's state as `outcome`: `running`, `succeeded`, `interrupted`, `failed`, or `unknown`. The device no longer needs one detail round-trip per session to find out which session has a run in flight, which is what lets its session picker and its hold-lock criterion work at all.
  - The value is resolved in the gateway rather than copied from the upstream row: upstream writes `outcome` only once a run settles and leaves it absent while a session is idle, so "absent" alone cannot tell a running session from one that was never prompted. `running` therefore requires the session to be present in the active-session map the relay already reads; `unknown` is reported for anything the gateway cannot decide for, and it means *not* running. The device reads a missing field the same way, so a gateway that predates the field behaves identically.
  - The `agent-gateway-v0` contract moves to 2.2 with the new field. The device-side copy, the schema, the manifest and the pinned `schema_sha256` are the same set of files as before and still move together, so a firmware build that sees a mismatched schema still fails rather than drifting.
- **OpenCode v2 upstream support**
  - New gateway reads for the capabilities that only exist in OpenCode v2: session message history (projected from the 11-way message union, oldest first, and trimmed cloud-side to the device's 12 KiB history ceiling), the pending permission list, the form/question list and its per-form state, the active-session map, spawned subagent sessions, session outcome, and run interruption.
  - Freeze the v2 upstream contract as test fixtures captured from a live server (OpenAPI excerpt plus raw SSE bytes) so the relay regression tests replay real envelopes instead of hand-written ones.
  - `web/scripts/opencode-gateway-smoke.mjs` now probes the six v2 endpoints and asserts every response is a `{data}` envelope rather than an error envelope.
- **ESP32 agent capability routes**
  - `GET /api/esp32/agent/sessions/{id}/history` backfills a session the device has not rendered yet, projected oldest-first from the upstream 11-way message union so the device appends in order.
  - `POST /api/esp32/agent/sessions/{id}/question` answers a pending form with the option value the device chose; the cloud resolves the form's field id (falling back to the form id when the detail read fails) and assembles the `answer` record, so the device never sees upstream field ids.
  - `POST /api/esp32/agent/sessions/{id}/interrupt` stops a submitted run and reports what upstream answered, treating "already finished" as a success rather than an error.
- **ESP32 agent gateway contract documentation**
  - Rewrite `web/contracts/agent-gateway-v0/README.md` so the cloud mirror matches the device contract again: nine device routes, eleven stream events including `agent.question`, the `agent.reasoning` channel that never feeds answer text, the bounds the cloud stays inside, and the upstream v2 path mapping that only the cloud knows.
  - Document how pending asks reach the device — v2 has no ask event, so permissions and forms are polled behind the active-session gate — and name the firmware-side contract copy as the authority for the wire vocabulary.
- **ESP32 OpenCode agent gateway**
  - Create device-visible OpenCode sessions through the gateway and verify each new session with a targeted binding-directory detail fetch before use.
  - Reply to pending OpenCode permission asks from the device, with corrective reject messages so the run continues; asks and echoes are deduped by permission id across both OpenCode event systems.
  - Re-attach to a running session's event stream without submitting a prompt (observe mode).
  - Emit SSE keep-alive comments during upstream silence and replace the fixed five-minute event cap with an idle timeout plus a configurable absolute cap.
  - Rate-limit every agent endpoint per authenticated device id and document the gateway contract under `web/contracts/agent-gateway-v0/`.
- **ESP32 device-control v3**
  - Add versioned claim, bootstrap, and synchronization contracts with shared golden fixtures.
  - Pair physical devices through an expiring display code and P-256 ECDH/HKDF/AES-GCM sealed credentials.
  - Persist request idempotency so device retries return the original result after server restarts.
- **ESP32 credential hardening**
  - Store only SHA-256 device-token digests and provide authenticated token rotation.
  - Create the application storage buckets during database migration.
- **Data integrity foundations**
  - Add entity revisions and immutable provenance records for AI-created notebook notes.
  - Record authenticated administrative activity through an append-only audit path.
- **Canonical problem semantics**
  - Add a Git-governed Canonical Subject and Knowledge/Skill Mark Registry with validated stable identities.
  - Project the Registry into read-only runtime tables and describe shell/part-level Problem targets and requirements without changing attempts, insights, or scheduling.

### Changed

- **OpenCode gateway speaks the v2 upstream contract**
  - Move every upstream path under `/api` (`/api/session`, `/api/session/:id/prompt`, `/api/session/:id/permission/:rid/reply`, `/api/event`) and read the `{data}` response envelope everywhere.
  - Move the configured agent and model from the prompt request onto session creation (`POST /api/session` with `{location, agent, model:{id, providerID}}`); the v2 prompt request accepts only `text` plus `delivery`.
  - Submit prompts with `delivery: 'steer'` so text reaches a run already in flight instead of queueing behind it.
  - Write the `agent.accepted` frame before the prompt request is issued and submit the prompt inside the SSE body, so a long-running `/prompt` no longer keeps the device waiting on response headers until its own socket timeout turns a successful run into `stream_incomplete`.
  - Use `?order=desc&parentID=null` on the session list: `order=updated.desc` is rejected with a 400, and the list includes subagent sessions unless `parentID=null` excludes them.
  - Project the v2 event vocabulary onto the unchanged device events: `event.properties.*` becomes `event.data.*`, the session id moves to `data.sessionID`, and every upstream event that is not named in the v2 vocabulary is dropped instead of passed through. `session.input.admitted`/`promoted` are now dropped, so the device no longer renders the user's own prompt as the first line of the answer, and reasoning travels its own `agent.reasoning`/`agent.reasoning.delta` frames that never touch the response text.
  - Replace the v1 `session.status idle` terminator with `session.execution.succeeded`/`failed`/`interrupted`; the failure path reports `agent.error` before the idle so the device gets the reason instead of a 30-minute `stream_incomplete`. A lost text delta is self-healed by replaying the whole part on `session.text.ended` only when the deltas already sent fall short of it.
  - Fill the silence v1 used to cover with `session.status`: `agent.status busy` on step start and compaction, and `agent.status retry` (with attempt and reason) while the upstream backs off.
- **OpenCode pending-ask delivery**
  - v2 has no permission or question events, so the relay now polls for them from the same event loop that reads the upstream stream: `GET /api/session/active` gates every round, spawned subagent sessions are re-discovered each round, and each new ask costs one permission-list read (or two, since `Form.Info` carries no state and only `Form.Detail` can tell an answered form from a pending one).
  - Deliver asks the device can act on and degrade the ones it cannot to status text: a question with more than two options, or with none at all, tells the user to answer in OpenCode instead of arming an unusable prompt, and a second ask is held until the first one has been answered because the device holds a single pending ask per kind. A pending form is projected onto the new `agent.question` frame as `{question_id, title, options[]}` with at most two ordered options; the cloud, not the device, knows how to turn a chosen value back into an `answer` record.
  - End an observe attach as soon as the session is absent from `/api/session/active` and its detail reports an outcome. v2's stream is live-only, so an idle session sends nothing at all — without this the device sat in `kRunning` for the full 30-minute cap and reported the watch as failed.
- **Unified AI tool contract (MCP registry as single source)**
  - Extract the shared tool contracts (name, description, parameter schema, annotations) of the 11 voice-relevant tools into the dependency-free `web/lib/mcp/tool-catalog.ts`; the MCP registry attaches zod schemas and handlers, and the voice pipelines project the same entries into OpenAI function definitions.
  - Serve two new MCP tools from the same lib layer the voice path already used: `create_word_deck` and `search_words` (registry grows from 36 to 38 tools).
  - Execute ESP32 voice tool calls through the shared MCP registry handlers for all three voice paths (v2 streaming, Flash realtime execute-tool, and the legacy v1 provider), replacing three independent tool-schema copies and two independent executors; the legacy in-provider mirror and its parity test are gone.
  - Rename two voice tools to the registry names: `list_word_decks` → `list_authorized_word_decks` and `add_word_to_deck` → `add_word_entry`; tool names only reach the LLM and device status events (firmware renders them verbatim).
  - Enforce the per-tool zod schema on the voice path: invalid or oversized arguments now return `invalid_arguments` with the reason to the model instead of being silently coerced or truncated, and voice tool failures are logged with their error code.
  - Surface the device `action` object from MCP write-tool results (`create_notebook_note`, `create_todo`, `update_todo_status`, `create_word_deck`, `add_word_entry`), which previously dropped it.
  - Record voice conversation/device provenance on AI-created todos and notes via the shared tool context; route MCP calls carry `conversationId`/`deviceId` explicitly as null.
  - Keep the device-facing contracts unchanged: `{ok, display, data, action}` envelopes, English v2 / Chinese v1 display strings, `tool.start`/`tool.result`/`tool.done` events, and the v1 `{success, data}` JSON shape.
- **ESP32 voice AI**
  - Add StepFun ASR selection for standard and professional voice sessions.
  - Accept both LF and CRLF event framing from upstream SSE providers.
  - Align v2 uploads on validated raw PCM headers and forward bounded thinking controls.
  - Translate provider reasoning chunks into device-visible thinking SSE events.

### Fixed

- **A second OpenCode session could not run while another one was streaming**
  - The agent-run idempotency ledger required one in-flight run per *device*, so a prompt into any other session on the same device was answered `409 run_in_progress` for as long as the first run lasted. A device is meant to hold several sessions and to run several of them in the cloud — only its live display is single-flight — so the claim was coarse by one dimension. The unique in-flight index is now on `(device_id, session_id)` and the busy check asks about this session rather than the device, so each session gets its own claim while a second prompt into the _same_ session still collides.
  - The invariant that wording was really protecting is intact, and measured rather than assumed: against a probe database, exactly one line of the claim path moves. A new prompt into a different session went from `busy` to `claimed`; a second prompt into the same session, the same-id attach replay, the fingerprint conflict, the terminal replay, the lease self-heal and the invalid-input rejection all return what they returned before.
  - Applying it over live data needs no cleanup: the index being replaced is unique on `device_id` alone among in-flight rows, so a device can hold at most one such row today, and a duplicate under the wider key would need two. `session_id` is `not null`, so the new key has no nulls-distinct escape hatch either.

- **A device that vanished mid-run pinned its session for half an hour**
  - When the device closed the SSE stream part-way through a run, the cloud left the run's idempotency row `in_flight` on the grounds that the upstream run might still be going. That is true, but the device is gone, so nothing can tell it anything: every later submission for that (device, session) pair got a busy answer until the 30-minute lease retired the row. The row is now retired as `failed/detached` the moment the disconnect is noticed.
  - The cost is stated rather than hidden: a same-id retry after a detach now sees a `failed` row instead of the `attached` row that used to let it link onto a live upstream run. That is the right trade for a device that disappeared — if it is really gone nothing wants that run, and if it comes back it submits a fresh id. No current UI path retries a run automatically behind a recording confirm, so nothing reaches this today.
  - `error_code` is a bare unconstrained text column on this table, so `detached` needs no enum migration and is only ever read by a human inspecting the ledger. The state is `failed` rather than `completed` because the upstream run may well have succeeded: this records that _this device's_ delivery failed, not that the work failed.
  - An observe attach is untouched. It carries no run claim of its own — the claim belongs to whichever run route opened it — and the observe route does not import the ledger at all, so the same relay outcome is discarded there exactly as before. The two behaviours are now pinned by tests that sit side by side in the run-route suite.

- **The app's own name was truncated in the navigation bar**
  - `Common.logoText` read `rong Question Notebook` in _both_ locales — the leading `W` was lost — and the W in the wordmark is supplied by the logo beside it, so the top bar read `rong Question Notebook` on desktop and `QN` on mobile for every user. It now reads `Wrong Question Notebook` in both locales, matching the landing footer and the mobile uploader, which were already writing the full name out.
  - A first pass translated the Chinese catalog to `错题本`, which spelled `W 错题本` — the W glyph means nothing in Chinese, so the two halves stopped forming a wordmark. The brand name stays untranslated: `Common.appName` remains the localized `错题本` for the accessible name, while the visible wordmark is the full product name in either locale.

- **Every answer on the review page was visible on screen without asking**
  - The worksheet was markup inside the review page marked with `print-*` classes, and every rule for those classes — including the `display: none` meant to keep them off screen — lived inside one `@media print` block. On screen they therefore had no styling at all: the answer key, the solution text, and the "正确选项：A, C" line under every choice problem rendered as ordinary page content. A student reading a problem saw all of it without clicking 显示解答, which made the reveal gate meaningless. The markup now exists only in the print document, and `lib/__tests__/print-sheet-css.test.ts` fails if the sheet's `display: none` ever moves back inside `@media print` or if a print rule escapes the `.print-sheet` scope.
  - Clicking 打印 also revealed the solution on screen: the old handler called `setShowSolution(true)` before printing, which landed after the print snapshot had already been taken — so it changed nothing on paper and left the answers showing in the app after the user cancelled. The print document renders answers from the problem itself and no longer touches the reveal state at all.
- **Printed worksheets lost the answer key, the solution images, and the problem title**
  - The answer key and the solution appendix were hidden by an ancestor: the solution card carries `data-print-hide="true"`, and the reveal content lived inside it, so `[data-print-mode='end'] .print-reveal-content { display: block }` could never win over the ancestor's `display: none !important`. Handwritten or photographed solutions — the solution assets are the main payload of a wrong-answer notebook — therefore never reached paper in any mode. The print document is no longer a descendant of anything hidden.
  - The printed sheet had no problem title. `.review-header-sticky` was hidden from print and the only paper header was a name/class/subject strip, so a multi-problem worksheet could not be told apart. The title is now the heading of every printed problem, numbered 1..N over the selected subset.
- **Printed option letters did not match the printed answer key**
  - Choice letters are hidden on screen whenever a problem is unsubmitted and its choices are randomised, so a fresh practice sheet printed blank option boxes while the answer key underneath referred to "A". The print document always emits the letters, in stored order — it deliberately opts out of both the shuffle and the hiding, because an answer key that says "A" has to point at the same "A" on the page.
- **Worksheets printed with the app around them**
  - The global print stylesheet hid a list of class names that happened to belong to the review page, and nothing else: the top navigation bar, the announcement banner, the problem-marks card, and the scheduler diagnostics (FSRS stability, difficulty, due dates) all printed onto a student's practice sheet. The open print dialog printed itself too — `setOpen(false)` and `window.print()` ran in the same synchronous block, so React had not removed the overlay before the browser snapshotted it. `body > *` now hides every sibling of the print document, so the shell, the nav, the sidebar, the marks card and any open dialog stay off the paper without each needing its own opt-out, and the dead `.no-print` and `review-section-green` rules are gone.
  - The problem-mark card is fetched client-side, so whether it appeared on a worksheet depended on whether the request resolved before the snapshot.
  - A dark theme printed white-on-white. Only `body` was forced to white; descendants kept their `dark:` values and `print-color-adjust: exact` then rendered them for real, so the problem title and the section headings vanished and the whole app shell printed as a dark block. The print document resets its own ink to black on white.
- **Printing could silently do nothing, and Ctrl+P printed an empty sheet**
  - The Android bridge returned `true` unconditionally, so when the print service was unavailable or `printManager.print()` threw, the page took the early return and never fell back to the browser's own print — the user pressed 打印 and nothing happened, with no message. It now reports the real outcome, raises the failure through the existing `onClientError` channel, and falls through to `window.print()`.
  - The answer-placement attribute was written to `<html>` only when the dialog's print button was used and cleared on `afterprint`. A Ctrl+P therefore printed with no attribute set, which left both the answer key and the answer line at their default `display: none` — a worksheet with no answer space at all. The attribute is gone; placement is React state.
- **Math formulas could print blank instead of as formulas**
  - Two copies of an un-awaited `import('katex').then(...)` ran from a `beforeprint` listener and from the print handler. Neither could work: `window.print()` blocks the main thread in Chrome, so the callback could not run until after the snapshot it was meant to fix, and the Android bridge dispatched `beforeprint` and started the print job in the same tick without waiting either. TipTap serialises math elements empty, so a document captured before `RichTextDisplay`'s effect ran had a _blank_ where the formula should be, which is harder to notice than raw LaTeX. The print document is committed with `flushSync` and the print call now awaits `waitForSheetReady()` — fonts, one animation frame, one macrotask — bounded so printing can never hang.

- **ESP32 Agent gateway relay against a real v2 run**
  - Tool blocks stop collapsing into one. `session.tool.called/success/failed` carry only the call id and no tool name, so the relay labelled every block from a field that is not there; only `session.tool.input.started` carries it. The name is now learned from that frame and attached to each call, and `call_id` is sent through so two calls of the same tool stay two blocks on the device instead of one block whose detail is the last call's.
  - A retryable step failure no longer ends the run as a failure. `session.step.failed` is a step, not a run — the agent retries it — but the relay emitted an unmarked `agent.error`, and an unmarked error is terminal on the device: the turn was shown as failed and every later tool block was closed as an error. The frame now carries `fatal: false`, and the three errors that really do end the run stay unmarked so absent still means terminal.
  - Stopping a run no longer reports success when it did nothing. The upstream answers interrupt with a bare `{interrupted}` rather than the `{data}` wrapper every other v2 route uses, so reading `.data.interrupted` yielded `undefined` either way and `!== false` called every stop delivered. The gateway now tolerates both shapes.
  - One oversized upstream frame no longer kills a healthy run. A tool that dumps a large file into `content` produces a frame well past the relay buffer, and overflowing that buffer used to end the stream — the device showed 「事件流断开」 for a run that was still working. The frame is now discarded and the run continues.
  - A subagent's ask is now answerable instead of only visible. The relay watches the attached session and every child it spawns, so an ask can arrive for a session the device never attached to — but the device read no owning-session field and replied on whichever session it had attached, and both reply routes are session-scoped upstream, so that reply 404'd and the run stayed blocked behind an ask the user believed they had answered. `agent.permission` and `agent.question` now carry `session_id`, the device answers on whichever session it names, and `assertOpenCodeSessionAccess` accepts a session whose parent is in the binding's own list (read from the candidate's `parentID`, so it costs one request rather than one per owned session). The tenancy boundary is unchanged.
  - The device's single option bar is released again. Both upstream queues are out-only, so an ask leaving a queue is the only signal that its slot is free — but the relay settled the permission slot and returned early, so a question that had been answered never got its own release check and held the bar for the rest of the run, dropping every later ask in that run. The poll now settles each slot against the queue its own ask came from, before arming anything.
  - The relay no longer mistakes a failed probe read for evidence that an ask was answered. A `Map` that stored only the session id collapsed "the list request failed" into "the list is empty", which released a live ask. Reads are now remembered as absent rather than as empty.
- **ESP32 agent gateway contract**
  - The schema describes the envelopes the routes actually answer. It modelled `{data}` with an `{error:{code,message}}` failure shape; every non-streaming route wraps in `{success: true, data}` or `{success: false, error}`, and a device-lookup throw answers through the app's shared `createApiErrorResponse` (`{error, status, timestamp}`) with no `code` at all. Three shapes that existed only on the wire are now named — the reply acknowledgement both reply routes send, the `latency_ms`/`asr` the transcribe route measures and the device discards, and that internal-error body — and every fixture carries the envelope, so each invalid one fails for the violation it claims rather than for a missing `success`. `version` stays at 2.0: the device reads `data`/`error` and ignores the flag, so this is a description fix, not a device-visible change.
  - The cloud copy is now a real mirror. `web/contracts/agent-gateway-v0/` held only a README that had drifted (six routes, eight events, a doubled `/agent/transcribe` path, an 8 KiB text limit, no `call_id`, no `fatal`, no question semantics). It now carries the schema, the manifest and the fixture set byte-for-byte, and `lib/__tests__/agent-gateway-contract.test.ts` pins the `schema_sha256` against the manifest — the same digest the firmware build enforces against its own copy on every configure — validates every valid fixture against the root schema, rejects every invalid one, and validates the envelopes these routes really send with payloads typed against the gateway's own interfaces.
- **ESP32 OpenCode agent gateway against OpenCode v2**
  - The device session selector is no longer empty. The gateway read a non-existent top-level `directory` field on each session row (v2 puts it on `location.directory`) and then compared it to the binding directory, which matched nothing and dropped every row. Tenant scoping is now the server-side `?directory=` query alone, and sessions whose own worktree differs from the binding are no longer silently discarded. The same bug made every action-time ownership re-check return `session_not_found`, so run, permission reply, and observe were all blocked behind it.
  - Creating a session no longer always fails closed. The gateway read `body.id` where v2 returns `{data:{…}}` and compared a directory field that does not exist, so every create returned `invalid_response` (502). Creation now verifies only that the new id is readable back through `GET /api/session/:id`.
  - Session titles fall back to 新 Session when upstream omits the optional `title` field, so the device renders a label instead of a blank row.
  - Permission replies travel the v2 session-scoped path with `decision` instead of `reply`.
- **Problem Mark annotation queue**
  - Schedule the bounded annotation drain (/api/cron/problem-marks-annotate) every 10 minutes and give it a platform time budget that covers its 240-second batch deadline. Without both, the best-effort post-response wake stayed the only execution path and any annotation it lost had no drain.
  - Persist enqueue failures to problem_mark_enqueue_errors instead of only raising a warning, so a Problem whose annotation head could not be written no longer fails invisibly.
  - Keep a live lease when re-enqueueing a Problem that a worker is still processing, so that worker renewal succeeds instead of orphaning its run row.
  - Realign stale annotation heads to the Problem current semantic revision when claiming, so a head left behind by a failed enqueue is drained instead of never being selectable again.
  - Add a terminal abandoned state for Problem Mark annotations. Contract failures (mismatched Registry lock, retrieval contract violation, unbuildable retrieval query, invalid annotation context) end the annotation on the first attempt, and an unparseable model response ends it after a small retry budget; everything else abandons once the attempt limit is reached. Abandoned annotations no longer hold a claim slot, and they stay requeueable so an operator can retry after the cause is fixed.
  - Expose Problem Mark queue health to super admins at /admin/problem-marks: status and error-code breakdowns, the age of the oldest pending annotation, recent failures, and enqueue failures captured above. Adds requeue actions for a single Problem and for the whole backlog, plus a requeue_all_problem_mark_annotations() function that also recreates annotation heads that were never created — the required escape hatch whenever the Registry lock changes.
- **Subject canonical mapping**
  - Resolve a Subject canonical key from a seeded alias table (canonical names plus Registry aliases) with a grade/edition qualifier fallback, replacing the hardcoded eleven-name match. Subjects named 高三物理, Physics or 物理竞赛 now map to physics instead of being skipped as unmapped, and a rename re-derives the key. An authenticated client still cannot assert its own canonical key, and an explicit server-side assignment survives a rename.
- **Skill retrieval profiles**
  - Select the embedding wire protocol from the locked profile instead of hardcoding one provider. The NVIDIA NIM profile (2048-dimension) is now usable through a second provider implementation, and switching published profiles is a lock change rather than a code change.
  - Add NVIDIA_API_KEY to the deployment environment lists and document DASHSCOPE_API_KEY, which was missing from env.example.
  - Reject a Registry artifact that contains no marks, so an empty Registry can no longer be synced silently.
- **Skill retrieval quality**
  - Include the Subject in the query cache key; the same question text under two Subjects previously shared a cached result.
  - Bound the assembled retrieval query, which could otherwise exceed a hosted model token limit because only individual fields were capped.
  - Add a minimum-score filter, disabled by default: the 76 published physics documents score a median 0.46 against each other, so the threshold must be calibrated against real query scores before it is enabled.
- **Problem Mark visibility and corrections**
  - Show the Problem Mark projection on the problem page: what the problem targets and which knowledge and skills it requires. The data was already produced and returned by the API but had no reader in the UI.
  - Let a learner own their marks: problem_marks gains is_user_override and a user source, the owner can manage their own marks, and re-annotation now replaces only derived marks instead of erasing everything.
- **Word study sessions**
  - Bound per-user progress lookups to fixed 100-ID batches so large word decks cannot overflow the Node HTTP parser and stall ESP32 session creation.
- **Device synchronization**
  - Preserve SM-2 progress and user-timezone day boundaries for device reviews.
  - Use one device-authentication path so database failures cannot be mistaken for invalid credentials.
  - Remove temporary logging of Authorization header prefixes.
- **Provider errors**
  - Report upstream service failures consistently as `provider_unavailable` with HTTP 502.
- **Streaming request safety**
  - Apply authentication, rate limits, audio validation, and body-size limits to the v2 path.

### Security

- **Authorization hardening for SECURITY DEFINER joins and RLS write policies**
  - Pin the `problems` side of the three SECURITY DEFINER reads that join through a caller-writable row — `get_due_problems_for_subject`, `get_due_problems_count` and `get_subjects_with_metadata` — to the caller, so a `review_schedule` row planted against another user's problem, or a foreign problem planted in the caller's own subject, can no longer surface that user's problem content, subject ids or counts. The three RPCs now pin `search_path` too.
  - Require ownership of every referenced row in the write policies that only constrained `user_id`: a Problem can only be created in, or moved into, the caller's own Subject; a status-history row must reference the caller's own Problem, which also closes the `ON CONFLICT (problem_id, changed_date)` upsert that could capture a victim's real status change; and a categorisation update must keep its attempt, problem and subject inside the caller's own rows.
  - Gate attempt writes on the referenced Problem being visible to the caller, so an attempt can no longer be planted on a problem the writer cannot see while practising a shared problem set still records one. Drop the redundant `Users can update own attempts` policy, which would otherwise OR past the new check, and narrow the two altered policies that were still declared `to public` to `authenticated`.
  - Reject a Problem create whose `subject_id` the caller does not own with an explicit 404 instead of letting the database's row-level-security error surface as a 500.
  - The migration ends with a self-check that aborts the push if any SECURITY DEFINER function in `public` lacks a fixed `search_path` or is still executable by PUBLIC.

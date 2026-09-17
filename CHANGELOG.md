# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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

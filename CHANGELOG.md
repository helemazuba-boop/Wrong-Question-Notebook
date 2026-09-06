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

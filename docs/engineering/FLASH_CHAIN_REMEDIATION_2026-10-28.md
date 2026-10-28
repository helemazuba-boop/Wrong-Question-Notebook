# Flash chain remediation and acceptance contract (2026-10-28)

The audit baseline is firmware 031e4c6157a4cb85fafa47097f865b2168528acf and WQN 0fe742adf20eee422290cfcac75aefeff982d2a8. The user confirmed StepAudio 3 connectivity. Repository defaults do not prove the deployed model/profile. This work repairs the Flash chain and aligns its content presentation with Agent while retaining the Flash status bar.

The full investigation is WQN_NOTE4_FLASH_CHAIN_AUDIT_2026-10-28.md in the shared workspace doc directory. It contains 27 baseline tracked items (plus the 2026-10-29 F28 upgrade/auth incident) and triages all 53 primary CodeBuddy claims. Evidence: 31 parser/history checks, 10 real RelaySession port scenarios, and 16 main-agent candidate-validation checks. Those reproduce pre-fix behavior; they are not post-fix acceptance.

## Required behavior

1. Audio is PCM16, 24 kHz, mono. Stream bounded complete-sample chunks after a bounded prebuffer; never require an entire generated response before first playout. Bound aggregate queued audio/bytes and WebSocket buffered bytes. A pacer must progress even when an upstream delta exceeds its token capacity.
2. Separate session, user turn, provider response, content item, tool call and playback generation. A cancelled/retired response must not regain permission to append audio/text or admit new tool calls. Already-dispatched writes keep their durable result/unknown-outcome semantics; cancellation is not a rollback of a database write.
3. Separate provider generation completion, relay queue completion and device playback completion. Stopping speech must also work after generation has ended. Local interruption rejects in-flight old audio until the corresponding playback reset is acknowledged.
4. Keep the existing WFLV v2 shape compatible. Any use of its reserved word for playback generation is explicitly negotiated; legacy peers continue using zero. Relay-only capability/control fields are never forwarded to StepFun.
5. Readiness means acknowledged configuration, not just WebSocket open or local send. Preserve explicit manual PTT mode, trusted per-turn context, server-owned tool allow-list, device Bearer identity and 401-only identity clearing. Optional VAD/full-duplex is not enabled by this bug-fix batch without echo/AEC acceptance.
6. PTT begin/end/cancel only enqueue owner commands from the UI. Hardware calls, draining and FINAL sends run on the lifecycle/transport owner. Retain identity and object lifetime when operations time out. Never repeat an indeterminate FINAL or automatically replay an unknown write.
7. Reset all Flash turn assembly IDs/flags at every new session/turn. Stop/join the WebSocket receiver before freeing or shrinking its reassembly buffers. Every returned playback item retires its queued-byte accounting; drop/short-write paths have an explicit incomplete/failure result.
8. Bound control/audio reassembly over both read chunks and actual WebSocket continuation frames. Reject a whole oversized/bad message through its terminal fragment. The vendored receiver must honor stop/no-progress without freeing a live task's client.
9. Sustained capture-zero and application-level silent turns have bounded recovery; transient reads remain recoverable. An error cannot leave an invisible active capture worker behind. Validate WFLV format/sequence independently of physical sample-continuity claims.
10. Normalize provider text/audio-transcript/ASR events with stable item IDs and no double text. Preserve completed/failed/incomplete/cancelled status. Assemble tools by call ID; continue generation once the source response is terminal and required tool results have arrived.
11. Feed the existing shared Agent history viewport: provisional/final user text, streamed assistant, explicit tool start/result/error, readable transient errors and waits. Match Agent content expansion/follow/manual-scroll behavior, retain the Flash status bar, and add no permanent footer or fake option band.
12. Publish playback state changes to UI snapshots and preserve necessary final/full-refresh intent. History eviction must not silently make a terminal update disappear. No UI network or storage call is introduced by content projection.

## Batch order

- B0: pin audit, contract and acceptance scope in both repositories.
- B1: relay bounded streaming/pacing, response audio retirement and pressure limits.
- B2: relay acknowledged configuration, turn/tool identity, terminal/error mapping and tool continuation.
- B3: firmware session reset, asynchronous PTT owner commands, capture/turn termination and safe teardown.
- B4: firmware playback accounting/generations, frame guards and interruptible WS receive.
- B5: Flash-to-shared-history projection and Agent content alignment.
- B6: complete combined acceptance and update evidence/implementation records.

The user explicitly authorized local batch commits and deferred acceptance until the end, without waiting for per-batch user/device review. Every batch still receives a scoped diff/whitespace review. No push, PR, deployment, production mutation or flash is authorized.

## Final acceptance

Run current-source focused Flash lifecycle/protocol/history/relay tests, existing related regressions, TypeScript/lint/format gates, and a zero-warning default ESP-IDF build with M8 and UI stack gates. Check affected configuration variants where applicable and review both worktree statuses/commits. A test that now still reproduces the old failure is not a fix PASS.

Device/HIL remains separately identified: weak network/backpressure, exact PCM continuity, cancellation during capture and already-generated playout, resource peaks, Agent switching, battery sleep/wake and actual EPD rendering. Virtual clocks, synthetic HIL logs and archived builds do not prove these properties. Record missing hardware/production evidence rather than relabel it as PASS.

## Implementation and final local acceptance (2026-10-29)

B0–B5 implementation and B6 local acceptance have been executed. Latest runtime commits are firmware `27ebd82` and WQN `4baaca6` (the initial-configuration timeout hotfix). The [validation record](FLASH_CHAIN_VALIDATION_2026-10-29.md) maps all 12 required behaviors, records exact test/build identities and keeps physical/production acceptance open.

The machine contract is now pinned on both sides. New firmware requires the negotiated playback-epoch extension and acknowledged manual PCM profile, so integrate/deploy the compatible cloud before using the new firmware. Legacy devices remain supported by the cloud with reserved zero. WFLV framing and optional provider features must not be silently reinterpreted.

Local results include a zero-warning default SDK build, M8/UI-stack gates, 13 affected configuration translation units, current 106 Flash/voice tests and both TypeScript checks. The full Web run is environment-limited by two localhost-bind tests; device HIL and production recovery after the hotfix are unconfirmed. No push/deployment/flash was performed in this session.

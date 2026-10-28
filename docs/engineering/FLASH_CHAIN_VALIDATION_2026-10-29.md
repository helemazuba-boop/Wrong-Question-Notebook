# Flash chain implementation and local acceptance (2026-10-29)

Local implementation is complete for the 27 baseline Flash findings and the subsequent initial-configuration race F28. This records source/build/host acceptance; device HIL and post-hotfix production confirmation remain open. The initial investigation's 31/10/16 checks reproduce old behavior and are not used as fix acceptance.

## Source identity and compatibility

- Firmware runtime: `27ebd8207a5b29b093cabd856f0da73c12f9c40b` on `fix/flash-chain-20261028`.
- Cloud runtime/hotfix: `4baaca6e40dcc67ecdb2603f82d2db40ad4904ad` on the same branch name in WQN. This ancestry also contains separately authored deployment/OpenCode integration commits; those are not Flash implementation claims.
- Authoritative contract: WQN `web/contracts/flash-realtime-v2`; firmware pins the same manifest/schema/23 fixtures (18 valid, five invalid), version 2.1, with content hashes. AJV validates actual relay-owned events; the firmware replays golden parser/history controls.
- WFLV v2 retains its 24-byte header and PCM16/24 kHz/mono payload. Playback epochs use the reserved word only after explicit capability negotiation. New firmware requires epoch support and confirmed manual PTT. Deploy the compatible cloud first. The new cloud still supports legacy devices using reserved zero.
- F28 is a server-side hotfix; an already-running device needs no reflash for it. Rebuild/select an image containing `4baaca6`; environment-only changes do not update image source. See [incident analysis](FLASH_CONFIG_TIMEOUT_2026-10-29.md) in WQN.

## Implemented behavior

| Contract requirements | Result and relevant evidence |
|---|---|
| 1: bounded streaming PCM | 960-byte/20 ms packets after 120 ms prebuffer; 300 ms pacing lookahead; 2 MiB aggregate PCM and 256 KiB socket budgets; 10 s pressure-stall guard. Host tests cover early first PCM, oversized deltas, retired responses and limits. |
| 2: response/tool identity | Separate turn/response/item/call IDs; cancel/create fence; one continuation after source terminal and required receipts. Already-admitted writes retain receipts, including retired-turn receipts. No unknown write replay. |
| 3–4: playback lifecycle and wire generations | Cancellation retires already-generated cloud backlog even when the device ring is empty. Device packets carry local generation; reset/response/end controls carry negotiated epochs. Provider completion, relay handoff and acoustic completion remain distinct. |
| 5: confirmed readiness | Device/account authentication precedes HTTP 101. Relay listeners precede resumed input. Acknowledged PCM/manual profile precedes session.ready. Per-turn context/authorization remains fail-closed. Real ws first-frame regression and auth cancellation tests pass. |
| 6: UI ownership | UI PTT handlers publish bounded commands. Lifecycle owner performs hardware, drain and FINAL work. Capture admission survives producer quiescence before release processing; indeterminate FINAL is not retried. Host ports exercise capture/queue/sender/release policies; real scheduling latency needs HIL. |
| 7: lifetime and accounting | Cold session resets history assembly IDs; receiver joins before buffer release. Every playback retirement accounts PCM once. A permanent playback worker acknowledges quiescence, avoiding reuse of a self-deleting task's static TCB. Lifetime ordering also received source review/build validation; no device race/stress proof is claimed. |
| 8: bounded receive | Aggregate text/audio caps apply to every read callback and real WebSocket continuation. Vendored partial-frame zero progress and stop have bounded exits. Host assembler and actual component ports pass. |
| 9: explicit failure | Sustained zero capture, DMA overflow, invalid format/sequence, playback drop/short write and business-silent turns terminate explicitly. Transient zero capture remains recoverable. Sequence checks do not prove physical sample continuity. |
| 10: event and tool projection | Native text/transcript chooses one source; full/terminal text fallback works. Terminal status is preserved. Item-only argument streams bind to call ID and do not borrow the newest response. Host fake-provider tests cover these contracts. |
| 11–12: Agent content and UI state | Flash feeds shared history/viewport with live user/thinking/answer, tool cards and visible errors. Follow/manual scroll and expansion use the shared renderer; Flash status bar remains. Playback idle publishes a changed snapshot; evicted live entries can be rebuilt. Same-renderer host content pixels match; physical EPD is untested. |

## Executed acceptance

The full logs and machine-readable finding-to-fix map are in the workspace archive `doc/audit-20261028-note4-flash/acceptance` and `remediation-results.json`.

- ESP-IDF **v5.5.6**, esp32s3, `idf.py -B build-wsl build`: exit 0, **zero warnings**, M8 ownership gate and UI stack gates passed. Binary size `0x383d60`, 11% of the smallest app partition free. Entry frames: UI 1872 B; submit 176 B; render 5120/5104 B. Runtime high-water marks remain a device check.
- M8 fixture target: **11 passed**. Real SDK translation-unit checks: **13 passed with zero warnings** across Flash v1, AI-disabled and Agent-disabled profiles; these are not full alternative images.
- Seventeen firmware host suites passed at `754bcc8`. Later source changes add the pinned contract and permanent playback worker; latest parser/history replay (**40 checks**) and playback restart/accounting tests passed, with the latest full build and affected profile checks above. Other source/test files retain their recorded identity. Relevant suites include capture/FINAL, frame assembly, vendored receive, audio runtime/overflow/timeouts, indicator, shared reading, UI stack, STD/stream/Agent and Agent-disabled behavior.
- ASan/UBSan remain enabled where the host scripts provide them. LeakSanitizer is disabled (`ASAN_OPTIONS=detect_leaks=0`) because this sandbox/ptrace environment cannot run it; this is not an LSan pass.
- Current Flash/related voice/auth/contract tests: **106 passed in eight files**. Includes nine upgrade tests, seven authentication tests and actual relay-event schema validation.
- Web type-check and independent relay TypeScript compile: passed. Mandatory WQN ESLint/format hooks passed: **zero errors, 164 existing warnings**; formatting passed.
- Current complete Web test run: **1835 passed, 36 skipped**; **two files could not run because listen on 127.0.0.1 returns EPERM** (`report-pagination.test.ts`, `query-pagination.test.ts`). Overall command exit 1; it is not an all-green suite.

## Remaining acceptance boundaries

No new StepAudio 3 production session, database write, redeployment, push, PR or device flash was performed by this work. The supplied production log is negative pre-hotfix evidence; after-deployment recovery is not yet confirmed. Optional VAD/full-duplex and provider retrieval remain design opportunities, not automatically enabled features; physical echo/AEC and turn ownership must be accepted first.

Device checks still require matching firmware/image identities: weak-network/backpressure, exact PCM continuity, interruption during capture and after model completion, rapid reconnect, I2S/amp behavior, resource peaks, Agent switching, battery sleep/wake and physical EPD rendering. No host result proves lossless ADC sampling, audible completion or panel timing.

Implementation work stayed in isolated worktrees. Original checkouts were unchanged at the earlier checkpoint; later read-only recheck found separately committed deployment-script changes and newer original HEADs, while their original dirty-status shape remained. They were not reverted or folded into the Flash fix. Preserve those concurrent changes when integrating these local branches.

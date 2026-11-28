# StepAudio 3 ASR snapshots and stable Flash user text

Real-provider input tests show that native ASR delta events contain cumulative, revisable text, not additive pieces. The observed sequence included 明天 → 明天上午九 → 明天上午 9 点提醒, followed by repeated identical full snapshots. Several arrived before input_audio_buffer.committed, while the existing relay had no authoritative input-item/turn association and discarded them. Final ASR still worked.

## Contract and ownership

Contract 2.2 adds optional `asr.partial` with positive turn_id and full text. The authoritative WQN schema, 24 fixtures and manifest hashes are mirrored in firmware. The relay normalizes the observed snapshot semantics only for the exact official StepFun CN realtime endpoint; other endpoints retain their existing native event behavior.

Before commit, at most eight input items retain their latest snapshot or early completion. Each preview is bounded to 8192 UTF-8 bytes with a visible truncation notice; a long preview does not abort otherwise valid audio. The relay publishes it only after the committed item is bound to the queued turn. An early completed transcript supersedes partials. A completed or retired item cannot be overwritten by a late delta. Cancelling clears pending snapshots as well as provider input PCM. Final ASR keeps its existing native event contract.

Firmware replaces the existing provisional user row on each asr.partial, retains its message ID and leaves recognition incomplete until final ASR arrives. It ignores partials after completion. It does not append cumulative snapshots, so numeric corrections do not duplicate text. This does not promise subtitles before relay turn admission or physical EPD timing.

Old firmware can ignore the new partial event and still receive final ASR. Updating the relay fixes the configuration/connection, tool and cancellation issues without reflashing. Updating firmware enables this additional partial-text projection; deploy the compatible cloud first. No device flash is performed by this work.

## Verification

- Real production RelaySession with actual stepaudio-3-realtime-preview: the long synthetic utterance produced correctly tagged asr.partial and final ASR; no response was created before FINAL. Context and business tools were loopback stubs.
- Host relay tests cover revisable snapshots, commit ownership, early completion, cancelled/stale items, byte/item bounds, UTF-8 truncation and late partials.
- Actual firmware parser/history replay: 43 checks passed. SDK v5.5.6 default build: zero warnings, M8 ownership and UI stack gates passed; app bin size 0x383da0 with 11% app-partition space free. Physical rendering and ADC/I2S continuity remain separate.

Archive: `doc/audit-20261028-note4-flash/incidents/20261029-flash-object-ack`, including original red traces, accepted real-provider traces, reproducible probe code and current local test/build logs. Credentials and complete session instructions are excluded.

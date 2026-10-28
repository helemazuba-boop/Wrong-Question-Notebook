# Flash v2 epoch contract

WQN owns these normalized controls; native StepFun ASR/reasoning events remain governed by the frozen provider contract. The wire subprotocol and 24-byte header version remain `wqn-flash-v2` / 2.

The cloud copy is authoritative. Firmware pins the same schema, fixtures and manifest SHA-256. Tests validate real relay emissions and replay these fixtures through the actual firmware parser. This is not a general JSON Schema engine on ESP32.

`session.update.wqn.playback_epoch=1` requests the extension. It never reaches the provider. Only configuration ACK of PCM16/24k/mono with manual turn detection permits `session.ready`. A legacy device omits the extension and receives reserved=0. The new firmware requires the extension; deploy a compatible relay before upgrading firmware. No deployment is performed here.

`turn.started` acknowledges relay admission only. `turn_id` binds normalized text, ASR, tools and terminal events; it does not acknowledge a database write or acoustic completion. Provider response IDs and tool call IDs remain distinct. Args without an association may execute only when authoritative terminal function-call output supplies one. A cancelled connection cannot safely infer source identity from its latest generation.

The negotiated WFLV reserved word carries `epoch`. `playback.reset` invalidates old packets; `playback.response` opens response media; `playback.end.samples` counts samples handed to the device socket, not samples played. Device metadata has a separate local generation so a new response survives retirement of old queued packets.

`tool.receipt` updates an already known prior card by call ID after cancellation. It cannot admit a new tool. A write timeout remains unknown outcome; voice cancellation is not write rollback. Each source response continues once after its terminal event and all admitted tool receipts.

Control messages are capped at 128 KiB, audio messages at 64 KiB, across TCP callbacks and WS continuation frames. Limits are message bytes, not JSON character counts. PCM is signed 16-bit little endian at 24000 Hz mono. Uplink reserved=0, STREAM=1, FINAL adds 2, sequence wraps as uint32 per connection; downlink is STREAM=1 with epoch only if negotiated.

Connection-level errors may carry `turn_id=0`; turn-scoped IDs remain positive uint32 values.

Contract 2.2 adds optional `asr.partial` full-text snapshots. StepAudio native ASR deltas are revisable cumulative text, not additive fragments. The relay retains at most eight unbound items / 8192 UTF-8 bytes per text, binds them only on commit, and never lets a partial overwrite completion. Old firmware may ignore the new partial event and still consumes the unchanged final ASR event. New firmware replaces the existing provisional user row for every partial.

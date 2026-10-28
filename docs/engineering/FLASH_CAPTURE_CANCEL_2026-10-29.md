# Cancelled capture must retire provider input PCM

The real StepAudio 3 test appended a synthetic utterance saying six, cancelled before FINAL, appended a fresh copy and then sent FINAL. Before the fix the final transcript was `六，六`: both recordings reached the committed provider input item. Cancelling a generated response does not clear uncommitted input audio.

The Flash response.cancel handler now also resets its uncommitted sample count and sends input_audio_buffer.clear. Connection sequence validation stays continuous, and queued commit identities are retained so late acknowledgements cannot be assigned to a newer turn. Already committed input, admitted tools and their receipts are not rolled back. Clear precedes any subsequent append on the ordered upstream socket.

Two host regressions verify that an empty FINAL after cancellation cannot commit the discarded recording, and that a fresh recording uses the next connection sequence and is committed exactly once after clear. The real-provider rerun recognized only one six and completed the response. All input was synthesized by the model; no microphone recording or WQN business write was used.

The live tests also observed that StepAudio ASR delta events are cumulative, revisable snapshots: for example 明天 → 明天上午九 → 明天上午 9 点提醒, including repeated identical final snapshots. Several arrive before input_audio_buffer.committed. The current relay deliberately waits for the item-to-turn binding and therefore drops those unbound partials; the completed transcript is delivered correctly. Live capture subtitles need a separately specified bounded snapshot/replacement projection, rather than forwarding these as additive deltas or guessing their turn. This remaining display improvement is recorded rather than described as already solved.

Configuration ACK, text/audio output, successive turns, single/multiple fake tools, cancellation during generation, early cancellation and cancelled-capture recovery have real-provider evidence in the audit archive. This does not establish physical PCM continuity, device playback or production deployment of the local commits.

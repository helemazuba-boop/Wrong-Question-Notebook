# StepAudio 3 manual configuration ACK: observed empty type

The actual provider response to `turn_detection: null` is an object containing exactly `{"type":""}`. This was observed for both initial and second configuration updates using the user-authorized `stepaudio-3-realtime-preview` key, then independently reproduced by the agent. The two-update probe completed in 298 ms. Credentials and complete instructions are excluded from the diagnostic output.

The production feedback at 18:07 UTC already showed an object with a string type, matching PCM formats and exact instructions. The previous logging whitelist replaced unrecognized type tokens with the word `string`, hiding that the actual value was empty. Consequently the omitted-field compatibility patch `b113cc2` did not resolve this production failure.

## Correction

For the exact official CN realtime endpoint, a matching PCM/manual configuration can now acknowledge either explicit null, the previously supported omitted field, or the live-observed object containing only `type: ''`. The compatibility forms require exact current instructions. Empty objects, whitespace types, VAD objects, extra fields and other endpoints remain rejected. Outgoing configuration still explicitly requests null; the firmware's normalized manual-profile contract is unchanged.

Mismatch diagnostics preserve the actual type token, bounded to 64 characters with a truncation flag, rather than reporting only its JavaScript type. This includes the empty-string case. This change records only the protocol token, not the complete provider object, instructions or credentials.

`web/server/realtime-proxy/probe-session-config.mjs` reads a key file and performs two configuration-only exchanges. It never sends audio, response.create or tool definitions. Its report retains only bounded format/profile fields and exact-match booleans; credentials are redacted even if echoed in those fields. Run with Node 24 and the relay's installed dependencies:

```sh
node web/server/realtime-proxy/probe-session-config.mjs --key-file /path/to/key.txt --model stepaudio-3-realtime-preview --output /tmp/flash-profile.json
```

The audit archive `incidents/20261029-flash-object-ack` also records real-provider tests against the production RelaySession with a loopback context/tool service. The fake executor only returns in-memory receipts and cannot write WQN data. Configuration, generated text/audio, continued turns, cancellation/recovery and synthetic-audio input are tested separately; a provider ACK alone does not prove those behaviors. Device/physical EPD/I2S acceptance remains separate.

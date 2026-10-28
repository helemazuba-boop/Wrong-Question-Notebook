# Flash provider ACK rejected after the upgrade hotfix

The second deployment log confirms the device configuration reaches RelaySession. Both connections receive `session.updated` roughly 30 ms after submitting configuration, then close at the 10 s ACK deadline. The failure is now ACK validation, rather than the earlier 30 s missing-device-configuration guard.

## Recorded evidence

Docker log `fc4cd34f53bbe4d58839a0ffdacce210ce7e18b289b6a118ce1f1d878056e155-json.log`, 16,907 bytes, SHA256 `94b1f9413e3198ea411b93e194047ebf4a25bb0ecb0d468b667a1eed0c3d44f9`:

- 2026-10-28 17:49:38.171 UTC submitted → 17:49:38.203 ACK mismatch → 17:49:48.173 timeout.
- 17:52:09.041 submitted → 17:52:09.070 ACK mismatch → 17:52:19.041 timeout.
- Both mismatches report PCM16 input/output true, manualTurnDetection false and instructionsMatch true. The old instructionsMatch predicate also returned true for an absent instructions field, so this boolean alone is not an exact-echo observation.
- Startup identifies `wss://api.stepfun.com/v1/realtime`; the deployed source SHA/model is not recorded. New authentication/configuration-stage log messages show the new upgrade path is active.

COM5 log `serial-COM5-261029-015139-831-14700.log`, 81,753 bytes, SHA256 `692bc38d7a8fbe92af274817c89e01b25c4ec60266a77f1d428cce0cc661fad8`: WebSocket connects at device uptime 33585 ms, closes at 43925 ms, I2S teardown reports both channels released, and the Flash connectivity demand returns to zero. No panic is present in this supplied log. This is evidence of the failure/cleanup path, not successful audio or complete HIL.

The mismatch logger did not record the VAD field's presence/type. Therefore the deployed ACK might omit turn_detection or contain an explicit value: the supplied logs cannot distinguish them. No raw provider ACK has been captured and no live model request is claimed in this work.

## Compatibility correction

The 2026-10-28 frozen official [Realtime API reference](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat.md) describes VAD as optional/default-off and its session response example omits turn_detection. The [developer guide](https://platform.stepfun.com/docs/zh/guides/developer/realtime.md) uses explicit null to request disabled VAD. The strict literal-null ACK check introduced while repairing F23 failed to normalize the documented omitted representation. Tests previously mirrored the outbound update and therefore hid this compatibility gap. Current online retrieval of those two pages was unavailable; the frozen primary documents and hashes remain in the audit archive.

The relay still sends explicit `turn_detection: null`. For the exact official CN endpoint `wss://api.stepfun.com/v1/realtime`, an ACK may omit that field only if it echoes the current submitted instructions exactly and confirms both PCM16 formats. Explicit null remains valid. An explicit server_vad object, empty object, false, zero, string, or other provider/endpoint does not gain this compatibility interpretation. Stale/default configurations cannot satisfy the instructions check. The same normalization applies to initial and per-turn configuration updates; the device's normalized manual-profile contract does not change.

Successful ACK logs include manualAck = explicit-null or stepfun-omitted-default-off. Mismatch logs now report turnDetectionField (omitted/null/object/array/scalar type), serverVad and instructionsPresent; instructionsMatch now means an actual exact match. No raw instructions, tool arguments, identity credentials or arbitrary provider object values are logged. ACK timeout reports a configuration/upstream_unavailable error to the device instead of a misleading context/internal error.

## Verification and deployment boundary

- Red regression on the previous implementation: the documented omitted-VAD shape does not produce session.ready.
- Fixed actual RelaySession regression: initial and per-turn omitted-VAD ACKs succeed; stale/missing instructions, explicit incompatible values, lookalike hosts and another path remain rejected.
- The real ws upgrade/receiver test now also replays the omitted-VAD ACK, covering upgrade → device config → provider ACK → readiness together, with mocked provider/DB ports and no TCP bind.
- Focused suite: 116 tests in eight files passed. Targeted ESLint passed without warnings. Web and independent relay TypeScript checks passed; mandatory full commit hooks are recorded with the commit.

This is another server-only correction; firmware is unchanged. Build/deploy an image containing the new local commit rather than redeploying only `4baaca6`. Production recovery remains unconfirmed. If the provider returns an explicit VAD object instead of the omitted form, it remains rejected and the new structural diagnostics identify that distinct case. Do not declare the entire connection or original robustness audit resolved from these local tests.

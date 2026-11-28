# Flash initial configuration timeout: upgrade/authentication race

The deployment log supplied on 2026-10-29 contains three Flash connections closed with `configuration:upstream_unavailable` after 29.896 s, 29.869 s and 29.878 s. This matches the relay's 30 s initial-configuration guard. It does not match the shorter provider configuration-ACK guard. The log does not include the deployed source/image SHA or a capture of the first device frame, so it cannot directly prove which packet the deployed process received.

## Cause and change

The previous entrypoint called `WebSocketServer.handleUpgrade` before awaiting device/account authentication. HTTP 101 was therefore visible to firmware while the relay had no device `message` listener. Firmware sends `session.update` immediately on CONNECTED; any frame emitted during that asynchronous database lookup was discarded by the EventEmitter. When authentication finished, the newly created RelaySession waited for a configuration that would never be sent again. Requiring a real provider ACK exposed this previously masked race.

`src/upgrade.ts` now authenticates before HTTP 101, pauses the transport during authentication, installs the selected Flash or batch-voice relay listeners synchronously, and only then resumes input. Both authoritative database lookups receive an AbortSignal. Authentication times out after 10 s; peer close/error cancels the pending upgrade and cannot create a late paid upstream session. Unauthorized/disabled/rate-limited/internal failures return HTTP 401/403/429/503 before upgrade. Existing 401-only device identity clearing remains applicable.

The provider configuration gate remains strict: PCM16 input/output and explicit manual turn detection must be acknowledged. Initial configuration logs now distinguish awaiting-device-config, loading-context and awaiting-provider-ack. ACK mismatch logs contain only profile-match booleans. Close reason text no longer overwrites the relay's shutdown cause with a Buffer.

## Evidence and rollout

- Source log: `98d4a0df736b6366aa4f006860abe373429e8dfd99c735ff13dd995e678095c1-json.log`, 29,217 bytes, SHA256 `d1b7f2e6fbb4f2e33867c961dfe5559392e6d8194b605a6b56786e8b6b969d18`.
- UTC intervals: 17:01:00.932–17:01:30.828, 17:01:34.088–17:02:03.957, 17:04:35.320–17:05:05.198 on 2026-10-28 (01:01–01:05 on 2026-10-29 in Asia/Shanghai).
- `web/lib/__tests__/flash-upgrade.test.ts`: nine tests cover the actual upgrade handler and Flash RelaySession, including a real `ws` server/receiver over an in-memory Duplex receiving the masked first frame during HTTP 101. No TCP bind, provider or production database is required. Other cases cover delayed auth/upstream, profile ACK, rejection, abort, timeout and batch routing.
- `web/server/realtime-proxy/tests/auth.test.ts`: seven tests, including a real Supabase SDK with a fake HTTP endpoint verifying cancellation on both authoritative lookups.

This is a server-side fix and does not require reflashing firmware. Select the hotfix commit explicitly for the rebuilt relay image; an environment-only update cannot replace image source. After deployment, confirm `device upgrade authenticated` → `Flash device configuration received` → `Flash provider configuration submitted` → `Flash provider configuration acknowledged`, followed by device readiness. This session has not redeployed the service or confirmed the fixed behavior against StepAudio 3 in production.

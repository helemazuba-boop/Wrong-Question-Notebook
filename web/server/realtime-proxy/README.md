# WQN Flash Realtime Relay

Standalone Bun service that bridges the wqn-zectrix-note4 ESP32 firmware
to StepFun's Realtime API for Flash-tier (real-time voice) AI sessions.

```
   ┌──────────┐   wss/8080   ┌──────────────────┐   wss/443   ┌────────────────┐
   │  ESP32   │  ─────────▶  │  Bun relay       │  ────────▶ │  StepFun        │
   │ firmware │  ◀─────────  │  (this service)  │  ◀──────── │  Realtime       │
   └──────────┘              │  – WFLV ↔ Re-   │             │  – PCM/Opus     │
                             │    altime frames  │             │  – 11 tools     │
                             │  – tool routing  │             │    via relay    │
                             │    via Next.js   │             └────────────────┘
                             └──────────────────┘
                                    │ http://localhost:3000/api/esp32/ai/execute-tool
                                    ▼
                              ┌──────────────────┐
                              │  Next.js WQN app │
                              │  (notebooks /    │
                              │   todos / words) │
                              └──────────────────┘
```

## Run locally

```bash
cd web/server/realtime-proxy
cp .env.example .env
# fill in STEP_API_KEY, SUPABASE_*, WQN_INTERNAL_API_BASE, WQN_REALTIME_PROXY_SECRET
bun install
bun start            # production-ish
bun run dev          # auto-reload
curl localhost:8080/health
```

The server expects:

- `STEP_API_KEY` — StepFun API key (server-side only, never sent to the device)
- `STEP_TTS_REALTIME_URL` — defaults to `wss://api.stepfun.com/v1/realtime`
- `STEP_TTS_MODEL` — defaults to `stepaudio-2.5-realtime`
- `SUPABASE_URL` + `SUPABASE_SECRET_KEY` — for Bearer-token device lookup
- `WQN_INTERNAL_API_BASE` — `http://localhost:3000` in dev, `http://wqn-app:3000` in prod
- `WQN_REALTIME_PROXY_SECRET` — long random shared with Next.js route at `/api/esp32/ai/execute-tool`

## Production deploy (Aliyun ECS)

The relay runs in its own container `wqn-realtime`. The checked-in
`docker-compose.yml` already defines it with an explicit environment whitelist.
For standalone remote deployment, use `deploy/deploy-realtime-remote.ps1`; it
derives `~/.env.wqn-realtime` and never uploads the full main-app env file.

Equivalent Compose wiring is:

```yaml
services:
  wqn-app:
    # existing
  wqn-realtime:
    image: registry.cn-<region>.aliyuncs.com/<ns>/wqn-realtime:latest
    container_name: wqn-realtime
    env_file: .env.wqn-realtime
    ports:
      - '127.0.0.1:8080:8080' # nginx only — never expose publicly
    restart: unless-stopped
```

The standalone scripts attach both containers to the private `wqn-runtime`
network and give the main app the `wqn` alias, so the relay callback URL is
`http://wqn:3000` without exposing the internal tool endpoint publicly.

### Nginx site config

Add to `/etc/nginx/conf.d/wqn-realtime.conf` (or alongside the existing
`wqn.conf`):

```nginx
# Reuse the existing TLS server block; just add this location under it.
location = /api/esp32/realtime {
    proxy_pass http://127.0.0.1:8080/api/esp32/realtime;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # Long-lived connection — disable response timeouts.
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_connect_timeout 30s;
    proxy_buffering off;

    # Bun's WS server inspects the Sec-WebSocket-Protocol header.
    proxy_pass_request_headers on;
}
```

Reload nginx after adding it: `nginx -s reload`.

## Protocol

### Uplink (device → server)

Binary frames, **24-byte little-endian header** + raw PCM s16le 16 kHz mono.
ESP32 packs exactly the same layout in `flash_session.cpp:L42-L62`.

| Offset | Type  | Field       | Notes                              |
| ------ | ----- | ----------- | ---------------------------------- |
| 0      | u32   | magic       | `0x57464C56` (`'WFLV'`)            |
| 4      | u16   | version     | `2`                                |
| 6      | u16   | flags       | bit 0 = stream, bit 1 = final      |
| 8      | u32   | seq         | monotonic per session              |
| 12     | u32   | sample_rate | `16000`                            |
| 16     | u32   | channels    | `1`                                |
| 20     | u32   | reserved    | `0`                                |
| 24+    | bytes | PCM payload | `240 frame × 2 B = 480 B` per tick |

The server forwards each chunk as two upstream JSON events:

```json
{ "type": "input_audio_buffer.append", "audio": "<base64 PCM>" }
{ "type": "input_audio_buffer.commit", "finalize": <true|false> }
```

### Downlink (server → device)

The server wraps each `response.audio.delta` from StepFun in a WFLV
binary header (same layout, with the negotiated output sample rate in
`sample_rate`) and ships it as a binary WS frame. ESP32 routes by magic
byte (`'WFLV'` ⇒ audio player).

Text frames are proxied transparently except for `audio.delta`. Control
JSON events emitted by the server have `type` set to:

- `session.ready` — sent once after upstream handshake completes
- `state` — heartbeat/stage markers (`session.negotiated`, `audio.complete`,
  `audio.last`, …)
- `tool.start` / `tool.done` — tool call lifecycle (currently informational
  only; firmware doesn't display them but logs them for diagnostics)
- `error` — domain error before WS close

### Tools

The ESP32 device never sees tools. When StepFun responds with
`response.function_call_arguments.done`, the server:

1. POSTs `{ user_id, tool_name, raw_args }` to the Next.js endpoint
   `/api/esp32/ai/execute-tool` (auth via shared secret).
2. Receives `{ ok, display, action }`.
3. Injects the result back upstream as:
   ```json
   { "type": "conversation.item.create", "item": { "type": "function_call_output", "call_id": "...", "output": "..." } }
   { "type": "response.create", "response": { "modalities": ["text", "audio"] } }
   ```
4. Narrates the result via the user's TTS stream.

Implementation references the
`openai/openai-realtime-console` project's `relay.js` (85-line bidirectional
relay) and `stepfun-ai/Step-Realtime-Console` for the upstream swap.

## Files

| File                     | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `src/index.ts`           | Bun server entry; HTTP `/health` + WS upgrade      |
| `src/auth.ts`            | Bearer token → `DeviceContext` via Supabase        |
| `src/types.ts`           | Frame constants & relay error codes                |
| `src/frameIo.ts`         | WFLV 24-byte header encode/decode                  |
| `src/voiceRelay.ts`      | Per-connection state machine                       |
| `src/toolInterceptor.ts` | `function_call_arguments.done` → HTTP exec → reply |
| `src/logger.ts`          | JSON-line logger for ECS                           |

## Tests

Smoke test: `python tests/ws_smoke.py` opens a WS to `localhost:8080`,
sends a `session.update`, then 240 frames of sine wave PCM at 16 kHz,
and asserts a `session.ready` + at least one audio delta comes back.

End-to-end: `python tests/ws_smoke.py --device-id <id>` runs against
the production deploy using a real device token.

## Known limitations / TODO

- No outbound rate-limiting per device — relies on the upstream
  StepFun throttle and the proxy's idle timeout. Add per-device counter
  if abuse shows up.
- Device-side `ping/pong` passthrough is fire-and-forget; we don't
  fail fast on dropped pong. Wait until we have an actual Playbook
  trace to decide whether to escalate.
- The relay swallows `conversation.item.*` events the device doesn't
  ask for. If the firmware ever needs full conversation state we can
  start passing them through with a feature flag.

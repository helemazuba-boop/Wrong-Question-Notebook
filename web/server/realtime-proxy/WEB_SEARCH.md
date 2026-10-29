# Flash provider web search

For `stepaudio-3-realtime-preview` on
`wss://api.stepfun.com/v1/realtime`, the relay can add
`{ "type": "web_search" }` to its authoritative upstream tool list. This paid
capability is **off by default**. Only an explicit `true` opts in:

```dotenv
WQN_FLASH_WEB_SEARCH_ENABLED=true
```

Unset, empty, `false`, `0`, `1` or unrecognized values remain disabled; `true`
is case-insensitive and surrounding whitespace is ignored. Use `false` to turn
it off. The setting is read at relay startup: recreate the container with the
updated environment, or restart a standalone relay process. A container restart
alone does not load changed env-file values. Editing a dotenv file alone does
not change an existing process or its live sessions.

For release/ops deployments, set this in `web/.env.production`; the shared
Realtime runtime allow-list carries it into the relay env file. The standalone
PowerShell deployment also whitelists it. Compose forwards it with a `false`
default. Local standalone runs can use the service's `.env` file. This is a
server-only setting, not a browser `NEXT_PUBLIC_*` variable.

The eight WQN business tools remain available when their executor is configured.
When opted in, native search also remains available when that executor is
disabled; it does not need the WQN execute-tool endpoint or a device
function-call implementation.

The device's `tools: []` does not remove server capabilities. Device-supplied
tool definitions are not merged into this allow-list. Reapplying session
configuration, including per-turn context refresh, adds the enabled native tool
exactly once. With server configuration present, disabled capabilities cannot
be restored by device-supplied tool definitions or flags. Other endpoint/model
combinations are not opted into native search. The existing custom-tool
authorization, execution receipts and generation fencing are unchanged.

The provider guide and model page advertise native search, while the API
reference's tool type enumeration only lists function/retrieval:

- [Realtime guide](https://platform.stepfun.com/docs/zh/guides/developer/realtime.md)
- [Realtime model](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime.md)
- [API reference](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat.md)

One direct probe on 2026-10-29 used the authorized preview model, one WebSocket
connection and one public weather question. Its session.updated acknowledged
all eight WQN functions plus web_search, then returned a completed message.
No WQN tool was executed and no client function_call_output was sent. The model
named a weather source, but emitted no separate native search receipt; its
source attribution does not independently prove retrieval or factual accuracy.
The probe establishes acceptance of the mixed configuration and the observed
provider-managed response shape, rather than a search-quality or device pass.

Regression coverage checks default-off/explicit opt-in, device bypass rejection,
deployment forwarding, authoritative replacement, idempotence, executor
independence, endpoint/model scoping, and the real RelaySession configuration /
context refresh / response-completion path. Native provider replies pass through
the existing text/audio response pipeline. This change adds no retrieval/vector
store configuration, client tool loop or firmware protocol field.

From `web/`:

```sh
./node_modules/.bin/vitest run --cache=false
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/eslint server/realtime-proxy/src/sessionConfig.ts \
  server/realtime-proxy/src/voiceRelay.ts \
  lib/__tests__/esp32-ai-tool-routing.test.ts \
  lib/__tests__/voice-relay-context.test.ts
```

This is a relay-only update; existing Flash-v2 firmware can keep sending its
current empty tool list. No deployment or device flash is included. Physical
voice interaction and production search behavior remain acceptance work.
Sanitized probe results, refreshed provider sources, test logs and source
identities are under
`/home/unknow/projects/doc/flash-web-search-20261029/`.

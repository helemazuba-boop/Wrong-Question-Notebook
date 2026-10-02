Client ID Metadata Documents have to be reachable from the app server. When
they are not, `lib/oauth/clients.ts` logs the rejection with a machine-readable
`reason` and returns null, which surfaces to the user as "The application could
not be identified".

## Diagnosing

```
{"level":"WARN","message":"Client ID metadata document rejected",
 "context":{"action":"resolveCimd","clientId":"https://...","reason":"unreachable",
            "message":"Client metadata host is unreachable (ECONNREFUSED)"}}
```

| `reason`      | Meaning                                           | Where to look                   |
| ------------- | ------------------------------------------------- | ------------------------------- |
| `dns`         | Host does not resolve (ENOTFOUND, EAI_AGAIN)      | resolver, split-horizon DNS     |
| `unreachable` | TCP refused/reset (ECONNREFUSED, ETIMEDOUT)       | egress firewall, security group |
| `timeout`     | Connected but no response within 8s (or TLS hang) | upstream slowness, proxy        |
| `tls`         | Certificate validation failed                     | MITM proxy, missing CA roots    |
| `http_status` | Host answered with something other than 200       | the client's own document       |
| `unknown`     | No errno code found on the error chain            | see below                       |

A `reason` of `unknown` alongside the message "Failed to fetch client metadata
document (no error code)" means Node's fetch failed without an errno code. That
is usually an egress proxy rejecting CONNECT, or a global fetch dispatcher /
undici patch in play -- check whether anything in the process installs an
`Agent` or wraps `fetch`.

Note the shape of fetch failures: undici flattens every network error into a
bare `TypeError: fetch failed` and puts the real errno on `error.cause`, which
can be several links down. Anything reading only the top-level `error.code`
will report `unknown` for every failure. `rootCauseCode()` in
`lib/oauth/cimd.ts` walks the chain and is covered by tests.

## The escape hatch: pinning

`resolveClient` consults `oauth_clients` BEFORE fetching a CIMD document. A row
whose `client_id` equals the client's metadata URL short-circuits the fetch
entirely. Unknown clients still go through CIMD, so pinning does not weaken
anything: it only substitutes an operator-verified copy of the same metadata.

This exists precisely because a blocked egress firewall and a dead server are
indistinguishable from inside the app, and the only alternative to pinning
would be disabling CIMD.

To pin a client:

1. `curl -s https://<client-host>/oauth/client.json`
2. Copy `client_id`, `client_name` and `redirect_uris` verbatim.
3. Insert them following `supabase/migrations/20260906000000_pin_unreachable_cimd_clients.sql`.
4. Do not widen `redirect_uris` beyond what the document declares.

Once outbound HTTPS works, delete the pinned rows: a pinned copy goes stale if
the client rotates its redirect URIs, whereas the live document tracks it.

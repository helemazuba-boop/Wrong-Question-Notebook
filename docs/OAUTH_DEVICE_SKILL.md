# OAuth device authorization and terminal Skill

The distributable source is `skills/wqn-terminal/`. It connects terminal-capable
AI clients through RFC 8628 without an inbound listener or native MCP integration.
The user approves in their browser on WQN; the CLI makes outbound HTTPS requests.
Existing OAuth code/PKCE clients and WQN owner-review rules remain supported.

## Server contract

- Discovery adds `device_authorization_endpoint` and the device grant URN.
- `/api/oauth/register` accepts device-only public clients with empty redirect
  and response type arrays. Every CLI installation gets its own client ID.
- `POST /api/oauth/device/authorize` accepts `client_id`, `resource` (the canonical
  `/api/mcp` URI) and `scope=mcp:all`. It returns a 256-bit device code, a 40-bit
  human code, verification URLs, 600-second expiry and a 5-second poll interval.
- `/oauth/device` requires login. GET displays consent only. The user confirms
  the terminal code and submits a Next Server Action with Origin checking.
  The action rechecks the grant, code hash, pending state and expiry.
- `/api/oauth/token` accepts `urn:ietf:params:oauth:grant-type:device_code` with
  `device_code`, `client_id` and `resource`. The database serializes polling,
  enforces slowdown, and consumes the code and inserts credential hashes in one
  transaction. The response includes `user_id` for local write-log ownership.
- Tokens use the existing 1-hour access / 90-day sliding refresh policy,
  rotation, reuse detection and revocation. No static credential is shipped.

Code/name labels identify the requested installation; a public client name is
not an attestation of the requesting software. WQN displays the logged-in account,
full scope and renewal policy before consent. Short-code lookup/decisions and
request initiation have bounded budgets; poll intervals are enforced in PostgreSQL
across application instances. Device records are service-only under RLS. A future
retention job can delete expired device requests without affecting issued tokens.

## Deployment and packaging

Apply `20261110000000_oauth_device_authorization.sql` before deploying the web
application. The migration expands the existing public-client constraints, adds
the device table and grants only service_role access to the poll RPC. Do not run
the new web endpoints against an unmigrated database.

After validation, run `python3 skills/package_wqn_terminal.py` to create
`artifacts/wqn-terminal.zip`, containing only `wqn-terminal/SKILL.md`,
`wqn-terminal/scripts/wqn.py` and `wqn-terminal/references/cli.md`. Exclude tests,
bytecode and all user state. Configure the user's WQN origin after import; see
the packaged CLI reference for persistent private storage. A client that imports
only Markdown without supporting files needs the complete bundle or a separately
installed CLI.

Validation commands from the repository root:

```sh
python3 -m unittest discover -s skills/wqn-terminal/tests -v
python3 skills/package_wqn_terminal.py
```

From `web/`, run the OAuth Vitest suites, type-check, lint, i18n check, production
build and client-secret check. The SQL regression under `web/supabase/tests/database/`
requires an isolated database with the OAuth migrations applied. Use
`python3 web/supabase/tests/database/oauth-device-concurrency.test.py --host <test-host> --port <test-port> --database <test-database>`
to exercise real concurrent redemption. Tests do not
deploy the server or establish acceptance in a third-party AI client's sandbox.

Rollback the web application first if necessary. Keeping the additive migration
is safe for existing code clients. Expanding scope or changing the OAuth lifetime
is not part of this feature.

## Local validation (2026-11-11)

Implemented in `feat/oauth-device-skill-20261110`, based on `6dcfa40` in an isolated
worktree. No changes were made to the primary checkout's pending migrations.

| Check                                                                          | Result                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Complete Vitest suite                                                          | 183 files passed, 4 skipped; 1,780 tests passed, 11 conditional skips                                                      |
| Focused OAuth routes, consent rendering/actions and existing clients           | 61 tests passed                                                                                                            |
| Shipped CLI against a local HTTP peer in separate processes                    | 19 tests passed                                                                                                            |
| PostgreSQL 16.15, original OAuth/resource migrations plus new device migration | Permissions, code/client/resource binding, pending/slowdown, denial/expiry, replay, TTL and atomic failure rollback passed |
| Concurrent real PostgreSQL sessions                                            | One issuance, one rejected replay, exactly one token row                                                                   |
| TypeScript and production Webpack build                                        | Passed using build-only placeholder environment values                                                                     |
| Lint                                                                           | 0 errors; 164 existing warnings; changed TS/TSX files have no warnings                                                     |
| i18n, changed-file formatting, whitespace, client-bundle secret scan           | Passed                                                                                                                     |
| Skill validator and allowlisted ZIP integrity                                  | Passed                                                                                                                     |

The build used the existing installed packages (Node 24.18.0, Next 16.4.0), with
local dependency paths so standalone tracing completes. It did not read production
dotenv files. The disposable database used a private Unix socket with no TCP
listener, a minimal auth fixture and the production OAuth migrations; it does not
establish acceptance against a complete deployed Supabase installation.

No production migrations, deployment, push, real account authorization, or
third-party AI client acceptance were performed. Import the ZIP only after the
server migration and application are deployed, and verify the target client's
private persistence location as part of that acceptance.

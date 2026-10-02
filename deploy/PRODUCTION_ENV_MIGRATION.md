# WQN production env migration review

This change intentionally does not deploy anything. Review and merge the
scripts first, then perform the following steps in a production maintenance
window.

## 1. Prepare the local release source

`web/.env.production` remains the single App release configuration source. It
is ignored by Git and may contain build, registry, App, Realtime, and database
maintenance values. `release.sh` projects that source into two independent,
least-privilege remote files:

- App: `~/.env.wqn-app`
- Realtime: `~/.env.wqn-realtime`

The security-sensitive origin/key split follows the current code reads:

| Variable | App | Realtime | Production policy |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | no | Browser/App API origin |
| `SUPABASE_URL` | no | yes | Realtime server-side API origin |
| `WQN_SUPABASE_EXPECTED_HOST` | yes | yes | Must match both URL hostnames |
| `WQN_ALLOW_HTTP_SUPABASE_ORIGIN` | if HTTP | if HTTP | Exact origin only; empty for HTTPS |
| `SUPABASE_SECRET_KEY` | yes | yes | Required by each component's server-side auth/data path |
| `SUPABASE_SERVICE_ROLE_KEY` | no | no | Legacy fallback forbidden by release policy |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | no | no | BuildKit build secret only |
| `TARGET_DATABASE_URL` | no | no | Local migration/tunnel only |
| `STEP_API_KEY` | no | yes | Realtime upstream only |
| ACR credentials | no | no | Local build/push only |

Before any release:

1. Set `SUPABASE_URL` to the server-side Supabase API origin used by Realtime.
   It must have the same origin as `NEXT_PUBLIC_SUPABASE_URL`.
2. Keep `WQN_SUPABASE_EXPECTED_HOST` equal to both URL hostnames.
3. Keep `WQN_ALLOW_HTTP_SUPABASE_ORIGIN` empty for HTTPS. For a private HTTP
   API origin, it must exactly equal that origin.
4. Verify `SUPABASE_SECRET_KEY`, then remove the value of
   `SUPABASE_SERVICE_ROLE_KEY`. A populated legacy key blocks deployment.
5. Add the maintenance-only database route shown in
   `web/.env.production.template`. Keep `TARGET_DATABASE_URL` on
   `127.0.0.1:15432` with a percent-encoded password. Each run resolves the
   live `supabase-db` IP using `ssh tencent` + `sudo docker inspect`, then
   forwards directly to that container's port `5432`.

Do not use `data.helema.cn` as a PostgreSQL host. It remains an HTTPS Supabase
API origin only. Do not add a public PostgreSQL security-group rule or a public
Docker port binding.

Before the first database dry run, verify on Tencent that PostgreSQL is bound
only to private container networking and confirm the Tencent security group has
no inbound PostgreSQL rule. The migration script never targets Tencent host
port `5432`, Supavisor, Kong, or the public Supabase API origin.

## 2. Review without deploying

Run the repository-only checks:

```bash
bash deploy/tests/run.sh
git diff --check
git diff -- deploy web/.env.production.template
```

After the production values have been reviewed, the database migration dry run
keeps the familiar entrypoint and opens/closes its own localhost tunnel:

```bash
./deploy/supabase-push.sh --dry-run-only
```

Do not run the apply form or `release.sh` as part of patch review.

## 3. Migrate the Aliyun runtime envs

The next reviewed `release.sh` deployment performs this migration
automatically, after both requested image pulls succeed and before replacing a
container:

1. Back up the existing App, Realtime, and legacy env files under
   `~/.wqn-env-backups/<UTC timestamp>-<pid>/` with mode `0600`.
2. Install `~/.env.wqn-app` and `~/.env.wqn-realtime` using a temporary file in
   the target directory, `chmod 600`, and atomic `mv`.
3. Detect old `*.supabase.co` values in `/root/.env.production` without
   printing them, back up the file, and rename it to
   `/root/.env.production.retired-<timestamp>`.
4. Start App only with the App env and Realtime only with
   `/root/.env.wqn-realtime`. `--remote-env .env.production` is rejected.

The existing containers keep their already-loaded environment if an image pull
fails; in that case no env file is changed and no container is touched.

## 4. Automatic post-deploy audit

The remote deploy helper checks the actual environment in both running
containers. It:

- compares every projected value with a local SHA-256 manifest and reports only
  key names/counts, never values or hashes;
- rejects forbidden credentials (ACR, Server Actions, database URL, legacy
  service-role key, and component-inappropriate App/AI secrets);
- prints only the parsed App, Realtime, Site, and internal callback origins;
- checks the Realtime health endpoint.

If verification fails, preserve `~/.wqn-env-backups/...` and the retired legacy
file for investigation. Restore only the required component env through the
same temporary-file/`chmod 600`/`mv` pattern; never make
`~/.env.production` active again.

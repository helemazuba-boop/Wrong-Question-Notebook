# WQN continuous integration

CI runs for every pull request and pushes to `main`, `release/note-baseline-prod`,
and `ci/**`. Workflow-only changes run the same checks. Nightly scans catch newly
published vulnerabilities even when lockfiles have not changed.

| Check                                        | What must pass                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Web checks, Vitest, production build         | TypeScript, ESLint, formatting, application and realtime relay tests, production build, client bundle secret check       |
| Dependency audit (web / realtime-proxy)      | No High/Critical production vulnerabilities; development findings need an exact, unexpired advisory exception            |
| CodeQL (JavaScript/TypeScript / Java/Kotlin) | Successful analysis and no unsuppressed High/Critical security findings                                                  |
| Project security rules                       | Rule fixture selftests and strict production-source Semgrep scan                                                         |
| Database (clean / upgrade)                   | All migrations apply, all pgTAP and ordinary SQL assertions pass, existing notebook data survives an upgrade             |
| Container (web / realtime-proxy)             | Final image builds and boots, health endpoint responds, Web sharp loads, image vulnerability and secret scans pass       |
| Browser E2E                                  | Login/logout, notes/images, CSV/XLSX imports, study progress, lost-response recovery and user isolation                  |
| Android build and unit tests                 | Debug/release compile, lint passes, at least four real JVM tests pass                                                    |
| Android native tests (API 30 / 36)           | Six native tests pass for WebView configuration, back navigation, error recovery, file selection, printing and downloads |

Browser PR checks use desktop Chromium and a mobile Chromium viewport. Nightly,
manual and `ci/**` runs also use Firefox and WebKit. CI has one browser worker,
one diagnostic retry and `failOnFlakyTests`; a retry-only success fails the job.
Authentication state and administrator credentials stay under ignored `.ci-local/`
and are never uploaded as artifacts. Test accounts are ordinary users. A service
key is used only by setup, cleanup and database assertions.

## Run locally

Requirements: Node 24, Docker, Supabase CLI 2.120.0, OpenSSL, PostgreSQL `psql`,
and `certutil` (`libnss3-tools` on Ubuntu). Browser certificate setup uses sudo
to trust a short-lived local CA and map two `.test` hosts. TLS verification and
the production Supabase hostname guard remain enabled.

```bash
# From the repository root. This starts and stops its own wqn-ci Supabase stack.
bash web/scripts/ci/run-e2e.sh --project=chromium --project=mobile-chromium

# Database clean-install tests, without application services.
bash web/scripts/ci/supabase.sh prepare
bash web/scripts/ci/supabase.sh start
bash web/scripts/ci/supabase.sh test
bash web/scripts/ci/supabase.sh stop

# Both complete lockfile audits and their policy tests.
node --test .github/scripts/audit-policy.test.mjs
node .github/scripts/audit-policy.mjs web artifacts/audit/web
node .github/scripts/audit-policy.mjs web/server/realtime-proxy artifacts/audit/proxy

# Android build and JVM tests.
cd android
./gradlew assembleDebug assembleRelease lintDebug testDebugUnitTest

# On a running API 30+ emulator. Uses packaged debug fixtures, no production site.
./gradlew connectedDebugAndroidTest -PwqnCiAssets=true
```

The Supabase runner refuses to overwrite an existing CI stack directory. After
manual database runs, remove `.ci-local/supabase` only after stopping its stack.
Database runs do not link to or migrate a hosted project. The upgrade job uses the
PR base commit, or `.github/ci-migration-baseline.txt` for non-PR runs. Update that
baseline to the new deployed release commit after each database release. Existing
migrations are immutable; add a new migration for subsequent changes.

## Vulnerability policy

`.github/security/audit-exceptions.json` contains advisory IDs, package scopes,
severity, justification and expiry. Exceptions apply only to development reports;
the independent production scan has no exceptions. New advisories, expanded
package scope, increased severity and expired entries fail. Registry errors or
incomplete responses also fail. Do not run `npm audit fix --force` in CI.

Container scans gate all High/Critical vulnerabilities and secrets. Reports,
CycloneDX inventories, health responses and logs are uploaded for investigation.
Images are built for testing and are not published by these workflows.

CodeQL findings are checked from SARIF as well as uploaded to GitHub Security.
`.github/security/ci-ruleset.json` defines the complete release merge gate and
can be applied through GitHub's repository rulesets API after validation.
Review and fix existing findings before enabling required merge checks. Configure
the stable job names in the table as required status checks once the workflows
are present on the target branch. GitHub's `Require code scanning results` can
add a CodeQL rule with `High or higher` security threshold. Enable checks on
`main` only after the workflows and their compatible dependency/migration baseline
have reached `main`; do not require absent workflows.

The Android local fixture origin is compiled into the debug build only with
`-PwqnCiAssets=true`. Release builds always use the production HTTPS host, contain
no fixture assets and keep cleartext traffic disabled. Debug permits cleartext
only for the instrumentation download server on `127.0.0.1`.

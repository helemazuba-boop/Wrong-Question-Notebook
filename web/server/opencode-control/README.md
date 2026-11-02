# OpenCode v2 controlled Agent requests

This package runs inside the OpenCode server. WQN admits a task into PostgreSQL;
native HTTP hooks reserve budget before each provider send. A rejected first
request can be replaced once, within the same inference request. The original
session prompt is never submitted again to perform fallback.

Supported boundary: OpenCode **2.0.16**, the
`@opencode/ai/providers/openai-compatible` driver, HTTP chat completions, and
single-choice responses. WebSocket, Responses API, unknown model context bounds,
missing route credentials, missing task admission and unavailable accounting fail
closed. Install this as the final request-modifying plugin in a dedicated WQN
location; other plugins must not modify its request after admission. Operator
changes to the server/plugin/driver require revalidation.

## Configuration and rollout

1. Apply `supabase/migrations/20261017000000_opencode_budget_control.sql` to the
   intended WQN database. The four RLS tables and RPC are service-role only.
2. Remove `WQN_OPENCODE_PROVIDER_ID`, `WQN_OPENCODE_MODEL_ID` and binding fields
   `providerId`/`modelId`, including empty assignments. Configure
   `WQN_OPENCODE_MODEL=stepfun/step-3.7-flash` and optionally
   `WQN_OPENCODE_FALLBACK_MODEL=opencode/deepseek-v4.1-flash-free`. These are example
   references, not a production routing decision. Start with
   `WQN_OPENCODE_FALLBACK_ENABLED=false`.
3. Generate a secret of at least 32 characters. Set
   `WQN_OPENCODE_CONTROL_SECRET` in **both** WQN and the OpenCode process. Keep it
   outside plugin options and source control. Provider keys also stay in the
   OpenCode process, referenced by `apiKeyEnv` in each route.
4. Copy this entire package to the OpenCode host. Add the following entry to that
   location's `opencode.json` `plugins` array. Use the actual absolute package
   path, HTTPS WQN URL, model endpoints, credentials and verified context bounds:

```json
{
  "package": "/srv/plugins/opencode-control",
  "options": {
    "controlUrl": "https://wqn.example.com/api/internal/opencode/control",
    "scope": "REPLACE_WITH_SHA256",
    "routes": [
      {
        "selector": "stepfun/step-3.7-flash",
        "protocol": "openai-chat",
        "url": "https://api.stepfun.com/step_plan/v1/chat/completions",
        "apiKeyEnv": "WQN_STEP_PLAN_KEY",
        "contextTokens": 256000,
        "outputBoundIncludesReasoning": true
      },
      {
        "selector": "opencode/deepseek-v4.1-flash-free",
        "protocol": "openai-chat",
        "url": "https://REPLACE_WITH_VERIFIED_ENDPOINT/chat/completions",
        "contextTokens": 200000,
        "outputBoundIncludesReasoning": true
      }
    ]
  }
}
```

`scope` is SHA-256 of `binding.baseUrl + "\0" + binding.directory`, using the
gateway's normalized base URL and exact directory string (Windows paths
included). Generate it without putting credentials on the command line:

```js
createHash('sha256').update(`${baseUrl}\0${directory}`).digest('hex');
```

The displayed context sizes match the local catalog during validation. Verify
them on the deployment host. `contextTokens` must cover the model's **entire
accepted context window** and must not understate `/api/model` metadata. The
controller intentionally reserves that whole bound, including framing, history,
system prompts and tools. It does not use character-count token estimates.
`outputBoundIncludesReasoning: true` is an operator assertion that this route's
enforced `max_tokens` also bounds reasoning tokens; unsupported providers must
not be enabled. The route is explicit: native authorization headers are not
forwarded, and a free model's name does not establish an unlimited/free quota.

For `#variant`, the route selector must match exactly and provide an explicit
`generation` mapping, for example `{"reasoning_effort":"low"}`. Allowed keys are
`temperature`, `top_p`, `reasoning_effort`, `thinking`, `enable_thinking`.
Primary reasoning options are removed when selecting a backup. Protocols and
provider-specific reasoning semantics beyond this boundary need a new adapter.
The `default` variant is canonicalized to the unqualified reference.

5. Set `WQN_OPENCODE_FALLBACK_POLICY_JSON` to a complete finite policy. Example
   starting point, to be reviewed for the actual providers and spending limits:

```json
{
  "maxInputTokens": 256000,
  "maxOutputTokens": 512,
  "maxTotalTokens": 1000000,
  "maxProviderRequests": 3,
  "maxSteps": 2,
  "maxDurationMs": 120000,
  "maxFallbacksPer24Hours": 3,
  "maxUserTokensPer24Hours": 2000000,
  "cooldownMs": 600000,
  "quotaGroups": {
    "stepfun/step-3.7-flash": "step-plan-account",
    "opencode/deepseek-v4.1-flash-free": "independent-verified-free-quota"
  }
}
```

For per-user bindings use `model`, `fallbackModel`, `fallbackEnabled`,
`fallbackPolicy` in the complete binding object. Quota group names must describe
verified independent pools. A 429 or exhausted balance cannot switch to a model
in the same group. Missing limits, unknown configuration fields and removed
model keys are rejected. Deployment validation requires Node 24, matching WQN.

6. Check `/api/plugin` reports `wqn.agent-control.v1` with `state.status=active`
   for the binding location. Enable fallback only after the controlled validation
   below. Production configuration and migrations are separate operator actions;
   this implementation does not apply them remotely.

## Admission, limits and recovery

A device must provide its 16-hex `request_id` for controlled execution. The task
snapshot is immutable on replay. The gateway refuses active/unapproved sessions,
selects the admitted model while idle, and submits one deterministic message ID
with `metadata.wqn_task_id`. A plugin with the wrong scope rejects that admission.
Older firmware without a request ID retains the single-model path.

Child sessions bind durably to the original task, and binding a child disables
fallback before it can make a model call. Each physical primary, compaction,
generate, retry or child-session request gets
a new reservation. Title generation is supplied locally. Native retries are
disabled for managed tasks; a subsequent Agent turn still needs its own budget.
Input, output, task total, physical calls, steps, deadline and user rolling token
budget are checked before sending. SQL serializes per-user budget admission
across devices and per-session task ownership. At most one fallback task per
user can be active. Preflight selection of a backup consumes the same one-switch
and daily allowance.

Provider 429, HTTP 402 and verified quota/balance codes are fallback-class errors.
Ordinary auth failures, local WQN 429, local budget exhaustion, uncertain submits
and cancellation are ineligible. Only the first primary model round can switch,
before response exposure or tools. The backup's failure ends the task. Output
and tool fences, cancellation, quota groups, cooldowns and budgets can veto an
otherwise eligible switch. Provider `Retry-After` can extend the configured
cooldown, capped at 24 hours; it does not delay cancellation. Classification is persisted even when switching is
unsafe. Device `agent.status/retry` reports the backup and reason; it is not a
second prompt or task.

Successful SSE `usage.total_tokens` settles the reservation. Missing/ambiguous
usage retains its full value; a timeout never assumes zero consumption. The
absolute deadline is propagated to provider requests. Cancellation is persisted
before interrupting OpenCode; database failure must not block the interrupt.
Detached/ambiguous tasks retain `unknown` and their reservations. Reattachment
observes the same execution and can reconcile a proven terminal outcome against
the captured task ID. A late result cannot downgrade a completed task or act on
a newer task in that session. Do not clear unknown tasks on a timer: inspect the
upstream execution or cancel it before resolving them.

## Validation

```sh
cd web
npm test -- lib/__tests__/opencode-agent lib/__tests__/agent-gateway-contract.test.ts
PGHOST=/tmp PGPORT=55439 PGDATABASE=wqn_opencode_control_TEST \
  python3 scripts/test-opencode-control-db.py
```

The database script requires an isolated migrated PostgreSQL database and minimal
device fixtures; it refuses non-test database names. It checks concurrent real
transactions, replay, rolling budgets, unknown reservations, task fencing and
service-role permissions.

`scripts/opencode-control-live.mjs` runs with **Windows Node**, the installed
OpenCode 2.0.16 CLI, and WSL PostgreSQL on `/tmp:55439`. Set `WQN_PLUGIN_SOURCE` to
this package's Windows/UNC path. It creates a new temporary project/database,
starts loopback fake providers and a secret-protected accounting bridge to the
real SQL RPC, then terminates its own OpenCode process. The default matrix uses no provider keys
and never changes the desktop/global configuration. The default matrix checks
429 → success, insufficient balance → success, backup 429 → stop, one-call budget
→ no backup send, and duplicate message admission → no additional call. Results
are saved to the printed temporary directory. Firmware build/host results do
not replace physical reply-latency, cancellation and reconnect HIL.

The optional `--real-stepfun` mode makes exactly one bounded call to the already
configured StepFun Step Plan `step-3.7-flash` model (64 output tokens, no tools).
It reads the existing provider credential in-process and does not print it.
Use this mode only with explicit provider-call authorization. On 2026-10-17 it
succeeded with 6978 prompt + 28 completion = 7006 total tokens, including 320
cached prompt tokens; SQL settled exactly 7006. This one sample does not certify
all reasoning variants or providers. The free DeepSeek route was exercised
with injected provider failures, not another live quota probe.

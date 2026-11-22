# WQN Agent marking

详细部署命令、环境变量、OpenCode 工作区与逐题验收：
[中文部署与测试说明](DEPLOYMENT.zh-CN.md)。

This worker classifies one Problem in one fresh OpenCode V2 session. An explicit
retry creates another run/session; process recovery reattaches the existing
session. Accepted MCP receipts, rather than assistant text or session success,
are the completion authority.

## Deploy

1. Apply `20261025000000_agent_problem_marking.sql` and
   `20261122000000_agent_mark_execution_deadline.sql` using the normal reviewed
   database release procedure.
2. Generate the matching OpenCode workspace in WQN-Knowledge-Registry with
   `npm run build:agent`. Copy `dist/agent-marking/` to the OpenCode host. It
   includes `opencode.jsonc`, the `mark` agent/Skill, catalog and method files.
   Changing provider-neutral content or the Skill requires regenerating the
   workspace and updating the WQN bundled artifact and its lock hash together.
3. Start an OpenCode **V2** service with that workspace as its directory. Use its
   effective provider configuration and a resolvable default model. Export `WQN_MARK_MCP_URL`
   and `PROBLEM_MARKING_AGENT_SECRET` to that service. The workspace connects
   only to `/api/mcp/mark`; it does not use the general user MCP or user PATs.
   V1 APIs/configuration are not compatible with this worker. Verify the V2
   `/openapi.json` supports client-assigned session/message ids, session
   metadata and the `/api/session/:id/prompt` input before enabling admission.
4. Configure the App with `PROBLEM_MARKING_ENGINE=agent` and the same independent
   secret (at least 32 random characters). Configure the worker from `.env.example`.
   OpenCode credentials belong to the worker, not the App or browser bundle.
5. Build `web/Dockerfile.mark-worker`, or use `web/docker-compose.yml`. Compose
   starts `wqn-mark-worker` alongside the App. Existing standalone releases can
   run the worker image with the dedicated env file and the App's Docker network.
   Verify OpenCode and MCP connectivity before starting the worker. Check
   `/health` for `ready: true` and `engine: agent` after startup.

The App image includes `agent-marking.bundle.json`; its SHA-256 and Skill version
are pinned in `knowledge-registry.lock.json`. App and OpenCode workspace must
publish the same bytes. The current lock pins Agent marking only. Deploy the
App and worker with `PROBLEM_MARKING_ENGINE=agent` from the first release. Stop
the worker to pause claims. A RAG rollback requires a compatible App release
with a pinned retrieval profile, matching active Registry and vector artifacts,
and provider configuration.

## MCP contract

The dedicated URL uses a service Bearer credential plus a per-run task token.
Only four tools are exposed: `get_mark_context`, `read_mark_images`,
`submit_mark_result`, `get_mark_receipt`. Every task tool takes the `run_id` and
`task_token` supplied by the worker. Tool schemas are advertised through
`tools/list`; context includes the complete result schema and canonical
`evidence_fields`. Each label needs an exact Problem quotation, matching
document/section quotation, and rationale. Assignments (`target`/`required`)
and method preferences (`recommended`/`alternative`) are separate relations.

Task expiry blocks new submissions, while receipt queries remain available.
Identical accepted submissions replay; a changed accepted result conflicts.
Internal runner control uses `/api/internal/problem-marks/agent` with the service
credential and a worker id. It is not exposed as an Agent tool.

## Recovery and operations

- Default concurrency is 2. Idle polling runs every second, and task polling
  every two seconds. A 90-second lease renews every 20 seconds. The first claim
  starts a five-minute execution budget. Renewing or taking over a lease retains
  that deadline. The workspace agent limits each run to 12 model steps.
- A run reserves its deterministic session id before creating it. Lost create
  responses read that same id. Lost prompt responses check the original message
  id; unresolved prompt acceptance is `PROMPT_OUTCOME_UNKNOWN`, never a replay.
- Graceful shutdown and lost renewal leave the bound session available for a
  replacement worker; the old worker cannot fail or interrupt its successor.
  The overall deadline and definite failures terminate the task. Owners can
  explicitly retry from the Problem's classification card; administrators can
  also use the existing queue UI. Failures never automatically create a new run.
- Queue health includes the latest Agent tasks. The private task rows retain
  accepted results, evidence, run/session identity and telemetry. Unknown token
  usage/pricing remains null; it is never interpreted as zero. History counters
  state whether their bounded page was truncated.
- Record user acceptance cases as a manifest with `problem_id` and expected
  classifications. Use `export-report.mjs` with the resulting run ids to export
  results, evidence, errors, timing and usage for per-case manual review. These
  exports contain Problem data; store them as local acceptance artifacts.

For an export, create an array of `{ "run_id": "<uuid>", "expected": { ... } }`
entries, then run this with the worker environment loaded:

```sh
node server/mark-worker/export-report.mjs acceptance-runs.json report.json
```

The report includes actual model identity, token usage, cost when known, queue
and execution time, tool counts, results and evidence. Review cases individually
for applicability, omissions and required versus recommended distinctions.

## Validation

Run Web type/lint checks, `npm run test:mark-worker`, the Agent/MCP tests and the
database pgTAP suite. The repository's container CI includes the worker image.
Use a disposable database for SQL tests; no production migrations are run by
the worker. A successful engineering smoke does not establish classification
quality: that requires the user's acceptance corpus and actual default model.
See [VALIDATION.md](VALIDATION.md) for this delivery's evidence and boundaries.

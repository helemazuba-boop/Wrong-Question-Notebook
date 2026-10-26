# Agent marking validation — 2026-10-25

This delivery is isolated on `feat/agent-marking-20261025` in both repositories.
No production migration, engine switch, deployment, push or real model request
was performed.

## Completed checks

| Check                                                    | Result                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Web full Vitest suite, `--maxWorkers=2`                  | 181 files passed, 4 skipped; 1747 tests passed, 6 skipped                              |
| New Agent contracts, service, MCP and owner routes       | 24 tests passed                                                                        |
| Worker execution and recovery                            | 11 tests passed                                                                        |
| Fresh database schema upgrade and pgTAP                  | All 32 assertions passed; fixture transaction rolled back                              |
| Actual MCP handler → evidence validator → PostgreSQL RPC | Accepted receipt, exact replay, invalid evidence rejection and one method row verified |
| Knowledge Registry `npm run check`                       | 36 TypeScript and 9 Python tests passed, validation/build/typecheck/format passed      |
| Web production `npm run build -- --webpack`              | Passed, including TypeScript and 107 generated pages                                   |
| Client bundle secret scan                                | Passed                                                                                 |
| Web format check and ESLint error check                  | Passed                                                                                 |
| i18n                                                     | Both locales complete, 2566 keys each                                                  |
| Release env policy                                       | Passed                                                                                 |
| Worker Docker image                                      | Built; default RAG health and containerized worker tests passed                        |
| Agent artifact identity                                  | WQN bundle equals generated workspace bundle and lock SHA-256                          |

The full suite's six skipped cases include the opt-in database integration smoke.
It was also run separately against a disposable database. Web HTTP tests and
Next's child processes were run outside the restrictive shell sandbox; a
sandbox port-bind failure was not treated as success.

Bundle SHA-256:
`0e07ffcbf3077269782c9addee1b5f58e8f6d7b7a8b94ad0ea641417dfd3543a`.

The pgTAP cases cover task permissions, lease rotation/takeover, one bound session,
atomic results and receipts, idempotency/conflicts, user overrides, copy,
objective revision changes, deadline failure and original RAG commits.
Worker cases include uncertain prompt acceptance without replay and a retired
worker leaving its successor's upstream session intact.

## Reproduce targeted checks

From `web/`:

```sh
npm run test:mark-worker
npx vitest run lib/__tests__/problem-marks-agent.test.ts lib/__tests__/problem-marks-agent-service.test.ts lib/__tests__/problem-marks-agent-mcp.test.ts lib/__tests__/problem-marks-owner-route.test.ts
npm run type-check
npm run format:check
npm run check:client-bundle-secrets
```

Run `supabase/tests/database/agent-problem-marking.test.sql` after applying the
migration to a disposable database containing WQN's existing schema.

The real database smoke is opt-in. Supply a fresh schema-complete database whose
name starts with `wqn_agent_mark_validation_`, in a local Supabase container
whose name starts with `supabase_db_`:

```sh
WQN_AGENT_TEST_DB=wqn_agent_mark_validation_fresh \
WQN_AGENT_TEST_CONTAINER=supabase_db_your_local_stack \
npx vitest run lib/__tests__/problem-marks-agent-database.test.ts --maxWorkers=1
```

This smoke seeds a synthetic user, subject and Problem. It intentionally refuses
other database/container names. Use a fresh disposable database for another run.

## Deployment and quality acceptance still required

The generated configuration and worker target OpenCode V2, including
client-assigned session/message identity. Startup rejects a V1 API. The existing
local WSL CLI is V1; real V2 workspace loading, MCP tool discovery, provider
behavior and model classification were not exercised by these engineering
checks. Container health in default RAG mode does not prove Agent admission.

Current registry content is 76 physics Skill definitions and no Knowledge
definitions. The framework supports both kinds, but absent definitions must be
reported as unresolved. Quotation validation proves evidence provenance, not
educational applicability.

Before rollout, apply the reviewed migration, synchronize the active canonical
registry and pinned workspace, configure the independent service credentials,
and verify worker readiness against the actual V2 host. Then evaluate the
user-supplied corpus case by case, exporting classifications, evidence, omissions,
required/recommended distinctions, queue/execution time, actual model, tokens and
known cost. No quality, latency or cost claim is made without that run.

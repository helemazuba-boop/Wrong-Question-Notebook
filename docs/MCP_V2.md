# WQN MCP v2

Implemented locally on `feat/mcp-v2-foundation`, 2026-10-14. This replaces the
external `/api/mcp` contract in one cutover. `initialize` advertises version
`2.0.0`; `tools/list` publishes 43 tools with generated JSON Schema inputs and
outputs. ESP32's eleven voice tools retain the separate v1 catalog, names,
parameters, prompts and protocol. No firmware change is required.

## User tasks and boundaries

| Task                                               | Workflow                                                                                                                | Completion boundary                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browse and review wrong questions                  | List collections, page manual or smart collection members, read full Problem, record a review rating                    | Smart collections query their saved filter and count actual matches. A rating is an idempotent direct action.                                    |
| Capture a Problem                                  | Read `get_problem_creation_spec`, then `create_problem` or `create_problem_from_images`                                 | Saves an ordinary `needs_review` Problem, printed options, tags, manual collection membership and review schedule together.                      |
| Supplement images or personal ideas                | Follow the returned WQN operation link                                                                                  | The logged-in owner uploads images or confirms/rejects the personal-idea draft. AI cannot complete these human actions.                          |
| Add answers, solutions or correct existing content | Read the current revision, submit `submit_problem_update`, `update_notebook_note`, `update_word_entry` or `update_todo` | Saves a proposal. WQN displays the normalized before/after changes; owner approval applies them once.                                            |
| Read Notes and study Words                         | Discover authorized scopes, start or resume a session, read the current item, record a terminal observation             | Responses include session statistics and one current item. `read_completed`/`skipped` and `known`/`unknown`/`skipped` advance the sequence once. |
| Add learning material                              | Create a Note in an authorized notebook, create a Word deck, add new Word entries                                       | A new deck does not grant AI access. The owner chooses read/create permissions in WQN. Duplicate normalized Words are conflicts, not overwrites. |
| Manage Todos                                       | List/read/create, propose content edits, directly complete/cancel/reopen                                                | Content and status use separate contracts and durable receipts.                                                                                  |
| Recover a failed or timed-out call                 | `get_operation_status`, then `resume_operation` when permitted                                                          | Original input stays fixed. A committed operation is never recreated, and waiting for owner approval returns the WQN link.                       |

Formal attempts, independent structured mistake classifications, bulk
organization, deletion and rollback tools remain outside this implementation.
The guide directs AI to report these gaps rather than invent student evidence,
store Problem analyses as Notes, or use knowledge tags as mistake categories.

## Contract and AI guidance

The external endpoint no longer accepts legacy field aliases or
`create_problem(get_prompt=true)`. Creation is a pure write; the specification
and workflow guide are separate read/control tools. Inputs reject unknown
fields, including owner IDs, revisions inside changes and system audit data.
Published schemas use JSON Schema 2020-12, with actual null unions for
`answer_hint`, `label`, `full_marks` and explicit nullable clears. Instructions
and examples use these same schemas; no empty placeholder objects are needed.

The initialization instructions and `get_workflow_guide` explain task paths,
permissions, missing capabilities, approval requirements, result states and
retry rules. Every tool returns:

```json
{
  "status": "completed",
  "data": {},
  "error": null,
  "operation": null,
  "next_actions": [],
  "warnings": []
}
```

`status` can also be `requires_user_action`, `in_progress`, `failed` or
`unknown`. `operation.execution_state` reports database execution separately
from pending human work. Both text content and `structuredContent` contain
the envelope; `isError` is true for `failed` and `unknown`. Input violations
return JSON-RPC `-32602` before business execution. Output validation failure
on a write returns `unknown` and directs the caller to its original receipt.

The creation specification preserves printed facts and never asks AI to solve
the question during extraction. `answer_hint` is for visible official answers;
AI-generated solutions and answer corrections can subsequently be proposed
for owner review. Confirmed personal ideas retain
`user_confirmed_external` provenance. Approved AI content changes retain
`ai_proposed_user_approved` provenance rather than becoming printed facts.

Problem reads expose revisions, per-part text/HTML, independent choices,
answer configuration, signed image references, personal-idea revision and
evidence origins. Legacy choice structures that cannot be reconstructed are
marked incomplete. Math survives conversion to plain text. WQN review,
printing and ordinary editing also preserve choices without an official
answer and imported part text. Compact Note sessions retain current images.

Authenticated-user budgets are separate: read 300, write 100 and control 100
requests per 15 minutes. They do not share the generic API limiter.

## Receipts, transactions and resume

Every distinct v2 write needs a new 16–64 character URL-safe `request_id`,
unique across all tools for that user. Only an identical retry may reuse it.
The SHA-256 fingerprint covers the tool, contract version and complete
canonical arguments, including personal-idea drafts and explicit nulls.
This also avoids collisions in the existing native study engine's shared
request-ID namespace. Changing input returns `request_id_reused`.

Unsubmitted retryable operations can resume for 24 hours from creation. A
five-minute execution lease renews every thirty seconds; concurrent claimants
cannot execute the same operation. Persisted preparation is reused. Expired
unsubmitted work returns `resume_expired`; permanent failures are not retried.
Committed receipts survive the recovery deadline. Pending owner review or
image/idea completion can occur later and cannot be advanced by resume.

Problem creation commits the Problem, tags, manual membership, schedule,
personal-idea challenge, user actions and operation receipt in one SQL
transaction. A challenge failure rolls back all business effects. PAT and
OAuth challenge sources have separate foreign keys. A committed receipt is
checked before lease/TTL/version checks, and a lost commit response is queried
before reporting its outcome. Transport failure after commit starts is never
recorded as a proven business failure.

Existing Note/Word study and Problem review RPCs execute inside the operation
transaction. Preparation permits only registered business commands; cache
creation is separate. Account state, credential validity and current resource
permissions are checked before effects. Native terminal-observation receipt
lookup precedes stale cursor validation. Old deterministic Problem IDs that
collide with an unverified v1 record return `legacy_unverified`; this migration
does not automatically repair or certify historical imports.

OCR and preparation caches, including normalized ingestion documents, are
outside the business transaction. The Problem retains owned original images
and ingestion/question/region references. Failure diagnostics remain private;
model-facing errors contain safe codes and retryability.

## Owner approval and image completion

`/mcp/operations/{operation_id}` requires owner login. The MCP setup page lists
pending reviews and human actions. Approval APIs use cookie authentication;
the MCP service role cannot execute approval or permission-grant RPCs. There
is no persistent automatic update permission.

Proposal submission checks the current resource revision, and a separate
personal-idea revision when relevant. Opening review creates a 15-minute nonce
bound to the latest complete snapshot hash. Approval rechecks that snapshot,
applies only allowed columns, records immutable before/after history and
commits the receipt atomically. Stale review returns a conflict and requires
the owner to reload the difference. Repeated approval returns the existing
decision without applying again. Nullable Word fields can be explicitly
cleared; omitted fields are preserved.

A normal Problem can be created before required visual evidence exists;
there is no draft lifecycle. The result supplies a stable WQN image upload
link, including when no required-image task was created. Roles are question,
answer, solution, student work and other. Solution uploads go to solution
assets. Uploaded paths must belong to the owner and exist in storage; image
attachment checks the current Problem revision. Upload alone leaves a
required-image task pending until the owner explicitly confirms completion.
The ordinary Problem asset API also checks ownership and revision.

`create_problem_from_images` accepts owned WQN `source_assets` references,
not raw base64 uploads. It checks downloaded image type/size and uses the
existing extraction service. Multiple independent questions are rejected by
that service for explicit selection through the WQN ingestion workflow.
Word-deck read/create permissions are chosen manually in either the operation
portal or existing deck page. System decks allow read access only.

## Files and migration order

- `web/lib/mcp/v2-contracts.ts`: strict contracts, DTOs and instructions.
- `web/lib/mcp/v2-tools.ts`: task orchestration and registered write preparation.
- `web/lib/mcp/v2-operations.ts`: fingerprints, leases, receipt recovery and native command interception.
- `web/lib/mcp/v2-readers.ts`: complete reads, smart collections and compact sessions.
- `web/app/api/mcp/route.ts`: external v2 endpoint; the v1 device registry remains separate.
- `web/supabase/migrations/20261014000100_mcp_v2_operations.sql`: durable operations, credential provenance and atomic commands.
- `web/supabase/migrations/20261014000200_mcp_v2_owner_review.sql`: owner proposals, approval audit, image completion and manual deck access.
- `web/supabase/tests/database/mcp-v2-operations.test.sql`: transaction and owner-authorization regression suite.

Both migrations are additive and must be applied, in timestamp order, before
the v2 Web application is exposed. Operations, prepared commands, receipts,
actions and approval history are service-only tables with RLS; owner access
uses the narrow authenticated RPCs. No existing user material is migrated or
rewritten by these files.

## Validation evidence

The following checks were run locally against the final implementation:

| Check                      | Result and scope                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Vitest suite          | 154 files passed, 2 files skipped; 1,526 tests passed, 1 skipped. Includes existing MCP, ESP32 voice, native study, Problem pack, print and edit regressions. Skips are not counted as passes.                                           |
| Published tool contracts   | All 43 input/output schemas compile in AJV 2020-12. AJV and server parsing agree on nulls and strict unknown fields.                                                                                                                     |
| PostgreSQL migration/pgTAP | Both exact migration files reapplied to an isolated test database; 70 assertions passed, no `not ok` results. Fault injection, actual native study/review RPCs, owner approvals, image completion and permission restrictions exercised. |
| PostgreSQL concurrency     | Two independent connections committed the same prepared Todo concurrently: one original receipt, one replay, exactly one business row. Synthetic fixture removed afterward.                                                              |
| TypeScript                 | `npm run type-check` passed.                                                                                                                                                                                                             |
| ESLint                     | 0 errors; 164 existing warnings.                                                                                                                                                                                                         |
| Translation keys           | English and Chinese keys match; all code references resolve.                                                                                                                                                                             |
| Production build           | `npm run build -- --webpack` passed using build-only Supabase placeholder credentials.                                                                                                                                                   |
| Client bundle              | `npm run check:client-bundle-secrets` passed.                                                                                                                                                                                            |
| Diff / format              | `git diff --check` and formatting checks for changed Markdown/TS/TSX/JSON passed.                                                                                                                                                        |

The PostgreSQL fixture restored a local schema and applied forward migrations
through the current branch before testing v2. It contains synthetic test data;
pg_cron setup was omitted because the container already reserves it for its
original database. The original local `postgres` database was not changed.
The default Turbopack build still encounters an environment-level port-bind
`EPERM`; the supported Webpack production build completed without disabling
TypeScript checks or altering dependencies.

These checks do not establish browser acceptance, a real OCR provider call,
production RLS/cutover, remote CI, or device HIL. They do not repair the reported
T15/T16 historical data. No production deployment or push was performed.

To repeat host checks, run from `web`:

```sh
npm test
npm run type-check
npm run lint
npm run check:i18n
npm run build -- --webpack
npm run check:client-bundle-secrets
```

The build requires the repository's production environment configuration.
For database regression, use a separate migration-complete database and run
the SQL file with pgTAP installed. Inspect TAP output and its plan: `psql` exit
zero alone does not prove that every assertion passed. The SQL suite wraps its
synthetic records and injected failure trigger in a rolled-back transaction.

## Cutover and rollback checklist

This checklist is prepared for a separately authorized deployment:

1. Capture the current application image and database backup. Pause external
   writes during cutover so old v1 writes cannot overlap v2 preparation.
2. From the repository root run `./deploy/supabase-push.sh --dry-run-only`;
   review the complete pending migration list, including branch prerequisites.
   Apply both migrations before releasing the matching Web application.
3. Release the application, reconnect external AI clients and refresh
   `initialize`, `tools/list`, `get_workflow_guide` and the creation spec.
   Saved v1 arguments must not be reused with v2.
4. Accept with real PAT and OAuth clients: create with null answer hints and a
   personal-idea draft; verify a lost-response retry; approve and reject edits;
   exercise stale review; supplement and explicitly confirm images; browse a
   smart collection; retry terminal Note/Word observations; manually grant deck
   read/create access. Verify an ESP32 voice session separately.
5. If rollback is needed, stop external writes and restore the recorded prior
   application image. Keep the additive schema, operation receipts and approval
   audit. Do not delete receipts or reinterpret pending v2 operations as v1
   work. Resume v2 human actions only with a matching v2 application.

## Delivery checklist

- [x] Strict v2 input/output schemas, guide/specification and surface separation.
- [x] Durable operations, leases, full fingerprints, atomic commands and OAuth provenance.
- [x] WQN approval/image APIs and UI, conflict checks and approval history.
- [x] Smart-set queries, full Problem structure, compact sessions and retry recovery.
- [x] Isolated PostgreSQL fault/concurrency checks and host/client contract regression.
- [x] Type/lint/build validation and cutover documentation.

Production deployment, live acceptance and historical user-data repair remain
separate actions.

# Problem Ingestion v1

`wqn.problem-ingestion.v1` is the provider-neutral boundary between source
images/OCR and WQN's canonical `problems` table. Its executable source of
truth is [`lib/problem-ingestion.ts`](../../lib/problem-ingestion.ts): the Zod
schema validates runtime JSON and the Structured Output schema in the same
module constrains the vision provider.

## Lifecycle

1. Input images are normalized and assigned `page-1`, `page-2`, ... in input
   order. The server, not the model, supplies authoritative source/provider
   dimensions.
2. A provider produces a versioned document containing pages, normalized
   polygons, regions and every recognized question. Raw provider payloads may
   be retained separately; provider field names never become WQN domain
   fields.
3. Each question keeps its shared stem, typed parts, options, visual region
   references and any visibly printed official answer. Student writing and
   marking live only in `student_work`.
4. The server validates the document and converts each question into a
   candidate for the existing Problem shell. A page with several independent
   questions produces several candidates; no adapter may silently choose one.
5. The accepted candidate becomes one ordinary `problems` row. Its `source`
   records the ingestion/question/region IDs, and the database trigger creates
   a traceability link. Existing Problem review schedules, attempts and
   per-part results remain unchanged.

## Contract invariants

- Collections are always arrays. Empty means “known to contain no items” or
  “none recognized”; `null` is used only for an unavailable nullable scalar.
- Content is an ordered sequence of `text`, `math_inline` and `math_block`
  nodes. Math node values contain TeX without `$` delimiters; JSON escaping is
  transport syntax and is not part of the stored math value.
- Coordinates are normalized to `[0, 1]` against the provider image. Regions
  reference a page and use polygons, so rectangle-only OCR providers are
  adapted without changing the contract.
- Printed question structure determines part type. Student answers, working,
  ticks/crosses and teacher marks do not change it and never populate a
  Problem answer key.
- `reference_answer` means only a visibly printed official answer/solution.
  Missing answers are `null`; ingestion never solves a question.
- Cross-page questions reference regions from several pages. Incomplete or
  unreadable recognition remains usable with `status: "partial"`, per-object
  confidence and warnings.
- Figures and tables are first-class regions, linked to the owning question
  and part through `visual_region_ids`; they are not reduced to a boolean.

## Persistence boundary

`problem_ingestions.document` stores the validated intermediate document.
`provider`, `provider_model` and optional `provider_payload` isolate external
implementation details. `problem_ingestion_problem_links` records acceptance
of one `question_id` into one Problem. The canonical Problem deliberately does
not copy OCR blocks, student work or polygons; those remain auditable source
evidence and do not leak into review/attempt semantics.

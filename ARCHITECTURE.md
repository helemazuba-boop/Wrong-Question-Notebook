# WQN Architecture

This document records cross-feature authority and dependency boundaries that must stay
stable while implementations and projections evolve.

## Human-centred review authorities

WQN has four independent authorities:

1. **A Problem defines what the problem is.** Objective Problem content, its Solution,
   and objective retrieval context are the only inputs to objective semantic marking.
2. **A learner defines what they thought.** Initial ideas, Review ideas, and the final
   Review Rating are personal facts. A machine may preserve the exact text or store a
   separate suggestion, but it cannot rewrite those facts.
3. **FSRS schedules from the learner's final Ratings.** Automatic marking is a default
   suggestion and a historical snapshot, not Card authority.
4. **AI retrieves, organises, and maps to the Knowledge Registry.** It cannot override
   Problem content, confirmed human evidence, a Review fact, or an FSRS Card.

These authorities form three separate semantic chains:

```text
Problem + Solution + objective retrieval context
  -> objective Problem Marking
  -> objective Problem Marks

initial idea + Review idea + human Rating + Attempt evidence
  -> Attribution
  -> human-reviewed Insights

effective human-final Rating stream
  -> FSRS
  -> Review schedule
```

A wrong answer does not imply that every Mark on the Problem is a learner weakness.
Problem Marks describe what a Problem objectively targets or requires; Attribution
records evidence about why one learner encountered difficulty.

## Forbidden dependencies

The following boundaries are load-bearing:

- Objective Problem Marking must not read user context, initial ideas, Review ideas,
  Ratings, Attempts, causes, Attributions, or Insights.
- FSRS must not read Problem content, Problem Marks, RAG output, ideas, causes,
  automatic correctness, Attributions, or Insights. Its input is the effective stream
  of human-final Ratings and event times only.
- Attribution and Insights must not mutate Problem content, objective Problem Marks,
  immutable Review facts, scheduler Applications, or the current FSRS Card.
- A derived annotation, Attribution, projection, or AI failure must not invalidate or
  delete an otherwise valid Problem or Review fact.

Enforce these rules both in module inputs and database query boundaries. Do not rely on
prompt instructions alone.

## Review facts and projections

A real Review occurrence has a stable `review_occurrence_id`. Rating corrections append
new immutable Events that supersede an earlier Event within the same occurrence; they
do not create another Review. The effective stream resolves each occurrence to its
terminal Event and then orders occurrences deterministically.

Review Events contain human and occurrence facts only. Scheduler calculations belong
in immutable schedule Application rows. Current due state is a projection and may be
rebuilt without changing the facts that produced it.

Writing a Review Event and marking its user/problem timeline dirty must happen in one
database transaction. A projector failure leaves the Event and durable dirty job
intact for recovery.

During FSRS shadow operation, physical projections remain separate:

- `review_schedule` is the current product authority read by all due consumers.
- `fsrs_review_schedule_projection` is the FSRS shadow Card and due projection.

Per-user cutover promotes only a ready, revision-matched FSRS projection into the
`review_schedule` authority in one transaction. Consumers do not switch query sources.

## FSRS baseline and parameter provenance

The initial runtime baseline is exactly:

- package: `ts-fsrs@5.4.1`
- algorithm: FSRS-6.0
- weights: the 21 official FSRS-6 weights shipped by that package
- requested retention: `0.90`
- maximum interval: `36500` days
- fuzz: disabled
- short-term mode: disabled
- learning and relearning steps: empty

WQN calls the upstream package through `web/lib/fsrs/`; it does not copy or reimplement
FSRS equations. Persisted Cards use `learning_step_index` even though the upstream
runtime field is named `learning_steps`.

Parameter sets are immutable. Activating a set means that the next genuine Review uses
it; activation alone does not alter existing due dates. Each occurrence receives a
stable parameter-set assignment when first successfully projected. Ordinary replay
retains those assignments, including across a mixed-parameter history, and therefore
calls `next()` once per occurrence with that occurrence's assigned parameters.
`reschedule()` is reserved for a single-parameter history, such as a reliable initial
migration or an explicit Reschedule All operation.

## Personal idea boundary

Initial and Review ideas are append-only personal revision histories, physically
separate from objective Problems. Setting and clearing are explicit revisions; a clear
revision stores `idea = null`. Idea changes do not increment a Problem semantic
revision, stale Problem Marks, or enqueue objective annotation.

Review flows hide initial and previous ideas until the learner's Rating is durable, so
historical text cannot contaminate retrieval. Rating projection never waits for an idea,
ASR, or Attribution.

Machine drafts and unconfirmed ASR transcripts are not human evidence. MCP confirmation
must be challenge-bound to the user/session, exact text hash, a short expiry, and a
one-time token before external text can be stored as human-confirmed evidence.

Append-only is a normal business-flow guarantee, not a barrier to account deletion or
an audited privacy purge.

# Device outbox receipt evidence v1

`POST /api/esp32/v3/study/observations/receipts`, `X-WQN-Protocol: 3`, device Bearer token. Request metadata uses the existing v3 shape. The independent `contract` tag keeps existing Word/Note request schemas and hashes unchanged. This contract is mirrored to firmware for the maintenance tooling; regular device upload code does not call it yet.

One request selects a Word or Note session and 1–64 unique original request IDs. Request bodies are limited to 16 KiB, replies to 64 KiB, and the RPC transport has a 5 s abort deadline. User/device identity comes solely from device authentication; the database rechecks device ownership, active account and session domain/actor. Only `service_role` can execute the read RPC. There are no business writes, row locks, projection wakes, idempotency-cache writes, ACKs or skip calls. The database function is STABLE and reads its session and facts in one SELECT snapshot.

Receipts preserve input order:

- `found`: the original actor/device/request row belongs to the selected session. Return its canonical observation ID, request ID, session ID, sequence, item, action, mode and timestamps. This proves a retained canonical row was found in that snapshot, not the integrity of every projection or local checkpoint.
- `conflict`: that actor/device request ID belongs to another session. No other-session payload is returned. It must not be downgraded to `not_found`.
- `not_found`: no retained canonical actor/device/request row was visible in this snapshot. This does not prove the request was never received, and does not authorize replay or removal. Deletion, retention or concurrent ingestion must not be inferred away.

Expired/retired sessions remain eligible for reads while owned rows exist. Missing, wrong-domain and unowned sessions share `OUTBOX_SESSION_UNAVAILABLE` / 404. Authentication, database/transport errors, malformed results and mismatched actor/session/order return errors, not a successful empty receipt. A malformed row invalidates the whole reply.

`next_sequence` is diagnostic only. Cloud rows cannot reconstruct local position/phase, establish the role of a corrupt record, undo a suspend marker, or authorize repair. Every successful reply includes `repair_authorized: false`. Responses use `Cache-Control: no-store` and do not disclose API credentials.

The JSON Schema checks wire structure; the service additionally checks request/reply identity, exact order/count, session mode and domain-specific actions. Word/Note response fixtures came from synthetic fixtures queried through actual service-role READ ONLY transactions; their timestamps are fixed examples, not live receipts.

R-08 remains open: bind authenticated receipts to the independently pinned source manifest and raw offsets/digests, produce an explicit repair plan, implement controlled maintenance delivery/rollback, and complete device/power-loss HIL. This API has not been deployed by this change.

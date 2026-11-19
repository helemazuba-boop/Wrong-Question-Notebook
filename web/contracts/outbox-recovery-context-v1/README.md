# Read-only outbox recovery context v1

`POST /api/esp32/v3/study/recovery/context` uses device-control protocol 3,
device Bearer authentication and the device's normalized 12-hex source MAC in
`X-WQN-Source-Mac`. It checks the current credential digest, active account,
device ownership, session ownership and source MAC in the database snapshot.
The response echoes the verified source MAC in `X-WQN-Context-Source-Mac`.

Use one challenge consisting of a 16-byte hex nonce, source manifest SHA-256
and firmware ELF SHA-256. Read the session part at offset zero first. Use its
`context_sha256` and the same challenge on every later request. The identity
covers the retained session configuration, ordered candidates, declared pins,
registry observations and actor/source challenge. A 409 requires discarding
the collected pages and reading a new context. A 404 covers unavailable
sessions, including absent data, ownership mismatch and changed pairing.

| Part         | Response contents                                            | Limit                  |
| ------------ | ------------------------------------------------------------ | ---------------------- |
| `session`    | Retained config, scope, local origin marker and array counts | One session            |
| `pins`       | Original pin and corresponding registry observation          | 8 per page, 32 total   |
| `candidates` | Original item fields, UUID spelling and stored order         | 32 per page, 500 total |
| `receipts`   | Ordered dispositions for supplied request IDs                | 16 per request         |

Pins and candidates use `next_offset` until `has_more` is false. A receipt
request supplies unique original request IDs and uses offset zero. Receipt
evidence is read in the same snapshot as its context digest check. Each batch
contains the canonical outcomes observed for those IDs at that read. Clients
must handle unavailable and conflicting observations explicitly. Both request
and response carry device-control request identity. The request limit is 4096
bytes and the response limit is 12288 bytes.

Word registry evidence reports the exact retained schema-2 pack variant by
deck ID, revision and SHA-256, plus the registry status observed at read time.
The session's content revision is a separate retained claim. Note registry
evidence reports the matching user-owned artifact row by notebook ID and
SHA-256. An unavailable registry record has an explicit missing state. These
records support independent cross-checking of retained local data. Historical
facts for unregistered sessions and independently attested historical Word
content revision, actor at the time of offline study, and full offline deck
order may still be absent.

Each result has `repair_authorized: false`. Firmware must revalidate its local
source after HTTPS and reconcile the evidence before any controlled repair.
This API performs no lifecycle, registration, receipt, projection or device
metadata writes. The existing receipt endpoint remains available to existing
clients.

The JSON schemas describe response data and request structure. Cross-field
page/actor/source checks live in the consumers. The fixture contains 25
database-origin pages from the rollback-only SQL suite, including all 500
Word candidates and all 32 Word pins. The checksum pins the exact bytes.

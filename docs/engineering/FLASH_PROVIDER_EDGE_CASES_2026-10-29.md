# StepAudio 3 live edge cases: item collisions and early cancellation

After fixing the empty-type configuration ACK, user-authorized real-provider tests exposed two additional failures in the existing Flash implementation. The fake context/tool HTTP service runs on loopback and stores receipts only in memory; no WQN business write occurs. Model concurrency remains below the user-authorized maximum of five.

## Multiple calls sharing an item ID (F24 follow-up)

The real provider emitted two distinct call IDs in one response, but both argument streams used the same coarse `item_20261029023608` item ID. The previous item-to-call bijection rejected the second explicit call, so the loopback executor received one create_todo instead of two.

Explicit call_id is now authoritative when its response ownership is valid. A conflicting item ID is marked ambiguous, and item-only fragments cannot infer either call. Complete explicit arguments still belong to their separate calls. Both receipts are required before the single continuation. Cross-response call reuse and all existing call/item/argument limits remain enforced.

Host regression replays the shared item ID, an unassignable item-only fragment, two distinct arguments and out-of-order executor completion. Real-provider rerun produced two independent fake receipts and a completed continuation.

## Cancel before response.created (F02/turn fence follow-up)

An early cancel was sent once while response.created was pending, then sent a second time when that late created event arrived. StepAudio returned response.done with status incomplete, followed by invalid_request_error / no ongoing response to cancel. By then the next response was pending, so the old current-response-only error guard closed the new session.

The ordered create/cancel pair is now sent once. A late response.created remains retired and does not cause another cancel. The exact benign no-ongoing-response message is tolerated for ten seconds following an actual cancel request, including after that response's terminal event; it never releases the cancel/create fence. All other errors remain fatal and the cancel deadline remains bounded. An expired allowance is covered by a host regression.

Real-provider rerun cancelled before response.created and then completed a new response without closing the session. Cancellation can finish as incomplete; the tests accept the actual terminal semantics rather than require the literal cancelled status.

## Evidence limits

The audit archive contains red and fixed real traces under `incidents/20261029-flash-object-ack`. Earlier exploratory harness failures from expecting asr.complete instead of the forwarded native event, requiring a literal cancelled status, and a result-field name collision are explicitly retained and classified as harness corrections. These are distinct from the two product failures above.

Matching firmware/device HIL, physical playback, echo, weak network and production deployment of the new commits remain separate acceptance steps. A successful loopback executor receipt is not a production database receipt.

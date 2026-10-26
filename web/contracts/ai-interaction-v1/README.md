# STD AI interaction v1

Canonical contract for confirmed STD input and pre-execution tool decisions.
Firmware mirrors this directory and pins the schema SHA-256 in `ai_interaction.h`.

1. Capture uses the existing ASR-only `/agent/transcribe` path (the name does
   not attach STD to OpenCode). The transcript stays outside chat history.
2. A later physical confirmation POSTs `{text,confirmed:true}` to `/ai/chat`,
   with `X-WQN-Ai-Tier: std`, a stable `X-WQN-Request-Id` and capability header.
3. STD exposes `ask_question` in addition to its eight existing voice tools.
   Questions accept 1-8 labelled values. The final 自己回答 item sends the
   reserved `__custom__` answer and interrupts the turn; it is not a text editor.
4. `create_todo`, `create_notebook_note`, and `update_todo_status` wait for an
   explicit device decision before calling the durable write executor. Read
   tools execute directly. A write card offers approve/reject only.
5. `/ai/interactions/{id}` accepts a device-bound `{answer,confirmed:true}`.
   Choices, arguments and the original time context are frozen. Duplicate
   answers replay; changed answers, wrong devices, unknown values and expired
   decisions fail. Pending decisions expire within five minutes and are
   cancelled when their request is abandoned. Approval does not replace the
   final database ownership/permission checks or the existing write receipt.
6. The stream emits waiting heartbeats every 500 ms. Its owner drains the
   nonblocking reply mailbox between reads; neither UI nor SSE callbacks send
   HTTP. `interaction.closed` retires a matching card even if its POST response
   was lost. A failed POST retries the same answer/id, never a new write.

The input gate and write gate are independent: confirming an utterance does
not approve a later mutation. Confirmation cards reuse Agent visuals and
selection semantics, with up to twelve preview lines on STD; long content is
an explicitly clipped preview, while the exact command stays server-side.
Older STD SSE clients without the capability cannot execute writes. Flash
retains its separate tool surface and execution behavior.

Deployment requires migration `20261026000000_esp32_ai_interactions.sql` and
the matching cloud routes before enabling this firmware. Schema and code
checks do not prove microphone, TLS heap/stack margin, panel timing or HIL.

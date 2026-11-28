# Note4 STD/PRO long SSE output checkpoint (2026-11-14)

PipelinePusher previously sent unbounded provider text chunks and repeated
complete text in thinking.done, text.end and final. Long output can therefore
exceed the firmware's unchanged 16 KiB line/frame ceiling.

Text deltas now use a 12 KiB encoded JSON budget, accounting for UTF-8, JSON
escaping and Unicode code-point boundaries, while preserving event order.
Oversized terminal text copies become empty strings only when the same content
was already streamed: reasoning/final use incremental SHA-256 plus byte counts;
sentence completion uses its accumulated deltas. Short authoritative corrections
remain unchanged. The device fallback keeps its streamed content.

Tool results, actions and receipts are never discarded or truncated. Oversized
metadata or differing unstreamed long terminal text raises a bounded pipeline
error instead of an oversized successful final. A tool mutation may already be
accepted before a transport error; that error does not reverse or repeat it.

Tests use the actual provider consumer, PipelinePusher and SseWriter for long
StepFun-style reasoning, answers, escaped Unicode, tool order, reconciliation
and receipt preservation. The test-only WQN_TEST_SSE_WIRE_OUTPUT variable exports
a synthetic stream for the native firmware parser/consumer/history replay.
No live credentials or provider calls are involved.

The firmware counterpart replaces frozen text prefixes with a bounded latest
thinking preview and consecutive answer segments. Both changes require
deployment/flashing and device regression. A local merge is not production
acceptance. This checkpoint changes no provider model, token limit, deadline,
paid-capability policy or receiver limit.

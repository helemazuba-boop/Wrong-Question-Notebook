/**
 * Device-requested detail tier, shared by the history projection (gateway) and
 * the live relay (events). It lives in its own leaf module on purpose: the two
 * consumers are forbidden from importing each other at runtime (see the header
 * of opencode-agent-gateway.ts), so the type, its default and the parser have
 * to sit outside both.
 *
 * 0 = brief: role + text, with a one-line digest standing in for a turn that
 * only ran tools. 1 = standard: text + tool blocks, no thinking. 2 = full:
 * everything -- the pre-tier behaviour, and the fallback for an absent or
 * malformed parameter (firmware that predates the tier sends none).
 */
export type OpenCodeHistoryDetail = 0 | 1 | 2;

export const OPENCODE_HISTORY_DETAIL_FULL: OpenCodeHistoryDetail = 2;

export function parseOpenCodeDetail(
  raw: string | null | undefined
): OpenCodeHistoryDetail {
  if (raw === '0') return 0;
  if (raw === '1') return 1;
  return OPENCODE_HISTORY_DETAIL_FULL;
}

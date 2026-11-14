import { PROBLEM_CONSTANTS } from '@/lib/constants';

/** Filter before ordering/pagination, including statements stored in parts. */
export function problemSearchFilter(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const term = `"%${escaped}%"`;
  const columns = [
    'title',
    'content',
    'solution_text',
    ...Array.from(
      { length: PROBLEM_CONSTANTS.PARTS.MAX_COUNT },
      (_, index) => `parts->${index}->>content`
    ),
  ];
  return columns.map(column => `${column}.ilike.${term}`).join(',');
}

export interface SseEventSplit {
  event: string;
  rest: string;
}

/**
 * Remove one complete SSE event from a text buffer.
 *
 * HTTP streams may use either LF or CRLF line endings. Searching only for
 * `\n\n` leaves CRLF streams buffered forever because their boundary is
 * `\r\n\r\n`.
 */
export function takeNextSseEvent(buffer: string): SseEventSplit | null {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');

  if (lfIndex < 0 && crlfIndex < 0) return null;

  const useCrlf = crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex);
  const index = useCrlf ? crlfIndex : lfIndex;
  const boundaryLength = useCrlf ? 4 : 2;

  return {
    event: buffer.slice(0, index),
    rest: buffer.slice(index + boundaryLength),
  };
}

export function extractSseData(rawEvent: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

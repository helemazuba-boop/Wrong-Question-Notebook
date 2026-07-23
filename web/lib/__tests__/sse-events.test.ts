import { describe, expect, it } from 'vitest';
import { extractSseData, takeNextSseEvent } from '@/lib/sse-events';

describe('SSE event framing', () => {
  it('splits LF-delimited events', () => {
    expect(takeNextSseEvent('data: one\n\ndata: two\n\n')).toEqual({
      event: 'data: one',
      rest: 'data: two\n\n',
    });
  });

  it('splits CRLF-delimited events', () => {
    expect(takeNextSseEvent('data: one\r\n\r\ndata: two\r\n\r\n')).toEqual({
      event: 'data: one',
      rest: 'data: two\r\n\r\n',
    });
  });

  it('joins multi-line data fields for either line ending', () => {
    expect(extractSseData('event: update\r\ndata: first\r\ndata: second')).toBe(
      'first\nsecond'
    );
  });

  it('keeps incomplete events buffered', () => {
    expect(takeNextSseEvent('data: partial\r\n')).toBeNull();
  });
});

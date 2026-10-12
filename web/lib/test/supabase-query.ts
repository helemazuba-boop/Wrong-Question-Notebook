import { NextRequest } from 'next/server';
import { vi } from 'vitest';

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

const methods = [
  'select',
  'eq',
  'in',
  'is',
  'not',
  'lt',
  'gte',
  'order',
  'limit',
  'range',
  'insert',
  'update',
  'upsert',
  'delete',
  'single',
  'maybeSingle',
] as const;

type QueryMock = Record<(typeof methods)[number], ReturnType<typeof vi.fn>> & {
  then: Promise<QueryResult>['then'];
};

/** Queue one result per query, while exposing filters and writes for assertions. */
export function queryResult(
  data: unknown = null,
  error: QueryResult['error'] = null,
  count?: number
): QueryMock {
  const result: QueryResult = {
    data,
    error,
    ...(count === undefined ? {} : { count }),
  };
  const query = {} as QueryMock;
  for (const method of methods) query[method] = vi.fn(() => query);
  query.single.mockResolvedValue(result);
  query.maybeSingle.mockResolvedValue(result);
  query.then = Promise.resolve(result).then.bind(Promise.resolve(result));
  return query;
}

export const TEST_USER = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'learner@example.invalid',
};
export const SUBJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const SET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const PROBLEM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const TAG_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

export function request(path: string, body?: unknown, method = 'POST') {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

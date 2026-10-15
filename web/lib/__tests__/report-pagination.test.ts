import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  TEST_USER,
  SET_ID,
  SUBJECT_ID,
  TAG_ID,
  params,
  request,
} from '@/lib/test/supabase-query';
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock('@/lib/user-management', () => ({
  isCurrentUserModerator: async () => true,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => state.client,
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemSet: vi.fn(),
  revalidateUserProblemSets: vi.fn(),
}));
import { GET as preview } from '@/app/api/admin/reports/[id]/route';
import { getFilteredProblemsCount } from '@/lib/review-utils';

const rows = Array.from({ length: 1101 }, (_, index) => ({
  id: `problem-${String(1100 - index).padStart(4, '0')}`,
  title: 'Reported',
  content: 'Body',
  parts: [],
  assets: [],
  problem_tag: [
    { tags: { id: TAG_ID, name: 'Keep' } },
    { tags: { id: 'other-tag', name: 'Other' } },
  ],
}));
const queries: URL[] = [];
let tagged = false,
  failed = false;
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  queries.push(url);
  let data: unknown;
  if (url.pathname === '/rest/v1/problem_set_reports')
    data = { problem_set_id: SET_ID };
  else if (url.pathname === '/rest/v1/problem_sets')
    data = {
      id: SET_ID,
      user_id: TEST_USER.id,
      subject_id: SUBJECT_ID,
      is_smart: true,
      filter_config: {
        tag_ids: tagged ? [TAG_ID] : [],
        statuses: [],
        problem_types: [],
      },
    };
  else if (url.pathname === '/rest/v1/problems') {
    if (failed) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'offline' }));
      return;
    }
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Math.min(Number(url.searchParams.get('limit') || 1000), 1000);
    data = rows.slice(offset, offset + limit);
  } else {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ message: 'Unexpected separate membership lookup' })
    );
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Range': `0-0/${rows.length}`,
  });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.client = createClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    'fake-local-key',
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  queries.length = 0;
  tagged = false;
  failed = false;
});

describe('smart report pagination past the PostgREST row limit', () => {
  it.each([false, true])(
    'visits all 1101 rows with tag filtering=%s and a stable secondary sort',
    async useTags => {
      tagged = useTags;
      const seen: string[] = [];
      for (let offset = 0; offset < rows.length; offset += 50) {
        const result = await preview(
          request(`/api/admin/reports/id?offset=${offset}`, undefined, 'GET'),
          params(SET_ID)
        );
        expect(result.status).toBe(200);
        const body = await result.json();
        seen.push(...body.problems.map((p: { id: string }) => p.id));
        expect(body.hasMore).toBe(offset + 50 < rows.length);
        const query = queries.at(-1)!;
        expect(query.pathname).toBe('/rest/v1/problems');
        expect(query.searchParams.get('offset')).toBe(String(offset));
        expect(query.searchParams.get('limit')).toBe('51');
        expect(query.searchParams.get('order')).toBe('created_at.desc,id.desc');
        expect(query.searchParams.get('user_id')).toBe(`eq.${TEST_USER.id}`);
        if (useTags) {
          expect(query.searchParams.get('select')).toContain(
            'matching_tags:problem_tag!inner'
          );
          expect(query.searchParams.get('matching_tags.tag_id')).toContain(
            TAG_ID
          );
          expect(query.searchParams.get('matching_tags.user_id')).toBe(
            `eq.${TEST_USER.id}`
          );
        }
      }
      expect(seen).toEqual(rows.map(row => row.id));
      expect(new Set(seen).size).toBe(rows.length);
      expect(queries.some(url => url.pathname.endsWith('/problem_tag'))).toBe(
        false
      );
    }
  );
  it('counts tag matches without downloading a truncated membership list', async () => {
    expect(
      await getFilteredProblemsCount(state.client, TEST_USER.id, SUBJECT_ID, {
        tag_ids: [TAG_ID],
        statuses: [],
        problem_types: [],
      } as any)
    ).toBe(1101);
    expect(queries).toHaveLength(1);
    expect(queries[0].searchParams.get('select')).toContain(
      'matching_tags:problem_tag!inner'
    );
  });
  it('returns a retryable unavailable response when the smart query fails', async () => {
    failed = true;
    expect(
      (
        await preview(
          request('/api/admin/reports/id', undefined, 'GET'),
          params(SET_ID)
        )
      ).status
    ).toBe(503);
  });
});

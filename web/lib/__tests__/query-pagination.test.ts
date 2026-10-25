import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { readAllQueryPages } from '@/lib/query-pagination';
import { getFilteredProblems } from '@/lib/review-utils';
import { buildNotePack } from '@/lib/note-packs';
import { getProblemSetWithFullData } from '@/lib/problem-set-utils';
import { TEST_USER, SUBJECT_ID, SET_ID } from '@/lib/test/supabase-query';
import { NextResponse } from 'next/server';

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: async () => ({ user: TEST_USER, supabase: state.client }),
  unauthorised: () => NextResponse.json({}, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
import { GET as listProblems } from '@/app/api/problems/route';

const rows = Array.from({ length: 1505 }, (_, index) => ({
  id: `problem-${String(1504 - index).padStart(4, '0')}`,
  user_id: TEST_USER.id,
  subject_id: SUBJECT_ID,
  notebook_id: 'notebook',
  sort_index: index,
  revision: 1,
  title: `Item ${index}`,
  content: `Content ${index}`,
  assets: [],
  created_at: '2026-01-01T00:00:00Z',
  problem_tag: [],
}));
const queries: URL[] = [];
let client: ReturnType<typeof createClient>,
  failAfter: number | null = null,
  serverCap = 137;
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  queries.push(url);
  const offset = Number(url.searchParams.get('offset') || 0);
  if (failAfter !== null && offset >= failAfter) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'later page unavailable' }));
    return;
  }
  const page = rows.slice(
    offset,
    offset + Math.min(Number(url.searchParams.get('limit') || 1000), serverCap)
  );
  const data = url.pathname.endsWith('/note_change_log')
    ? { change_seq: 7 }
    : url.pathname.endsWith('/problem_sets')
      ? {
          id: SET_ID,
          user_id: TEST_USER.id,
          subject_id: SUBJECT_ID,
          is_smart: false,
          sharing_level: 'private',
          subjects: { name: 'Math' },
          problem_set_shares: [],
        }
      : url.pathname.endsWith('/problem_set_problems')
        ? page.map(row => ({
            id: `link-${row.id}`,
            problem_id: row.id,
            added_at: row.created_at,
            problems: row,
          }))
        : page;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  client = createClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    'fake-local-key',
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  state.client = client;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  queries.length = 0;
  failAfter = null;
  serverCap = 137;
});
const filter = {
  tag_ids: [],
  statuses: [],
  problem_types: [],
  days_since_review: null,
  include_never_reviewed: true,
};

it('collects all 1505 smart members even with a server cap lower than page size', async () => {
  const actual = await getFilteredProblems(
    client as any,
    TEST_USER.id,
    SUBJECT_ID,
    filter
  );
  expect(actual.map(row => row.id)).toEqual(rows.map(row => row.id));
  expect(new Set(actual.map(row => row.id)).size).toBe(1505);
  expect(queries.at(-1)!.searchParams.get('offset')).toBe('1505');
  for (const query of queries) {
    expect(query.searchParams.get('limit')).toBe('500');
    expect(query.searchParams.get('order')).toBe('created_at.desc,id.desc');
    expect(query.searchParams.get('user_id')).toBe(`eq.${TEST_USER.id}`);
  }
});

it('keeps explicitly paged callers bounded', async () => {
  const actual = await getFilteredProblems(
    client as any,
    TEST_USER.id,
    SUBJECT_ID,
    filter,
    undefined,
    { offset: 100, limit: 20 }
  );
  expect(actual.map(row => row.id)).toEqual(
    rows.slice(100, 120).map(row => row.id)
  );
  expect(queries).toHaveLength(1);
});

it('manual set detail includes all 1505 junction members with their original order', async () => {
  const result = await getProblemSetWithFullData(
    client,
    SET_ID,
    TEST_USER.id,
    TEST_USER.email
  );
  expect(result?.problem_count).toBe(1505);
  expect(result?.problems.map((row: { id: string }) => row.id)).toEqual(
    rows.map(row => row.id)
  );
  const memberQueries = queries.filter(q =>
    q.pathname.endsWith('/problem_set_problems')
  );
  expect(memberQueries.at(-1)!.searchParams.get('offset')).toBe('1505');
  expect(
    memberQueries.every(
      q => q.searchParams.get('problem_set_id') === `eq.${SET_ID}`
    )
  ).toBe(true);
});

it('manual set detail fails instead of caching an empty or partial collection', async () => {
  failAfter = 411;
  await expect(
    getProblemSetWithFullData(client, SET_ID, TEST_USER.id, TEST_USER.email)
  ).rejects.toThrow('Failed to load problem set members');
});

it('preserves the owner and tag relationship scope on every page', async () => {
  const owner = 'owner';
  const actual = await getFilteredProblems(
    client as any,
    TEST_USER.id,
    SUBJECT_ID,
    { ...filter, tag_ids: ['tag'] },
    owner
  );
  expect(actual).toHaveLength(1505);
  for (const query of queries) {
    expect(query.searchParams.get('user_id')).toBe(`eq.${owner}`);
    expect(query.searchParams.get('matching_tags.user_id')).toBe(`eq.${owner}`);
    expect(query.searchParams.get('matching_tags.tag_id')).toBe('in.(tag)');
  }
});

it('does not publish a partial collection after a later page fails', async () => {
  failAfter = 411;
  await expect(
    getFilteredProblems(client as any, TEST_USER.id, SUBJECT_ID, filter)
  ).rejects.toThrow('later page unavailable');
});

it('note pack includes every note beyond a server row ceiling with stable SHA', async () => {
  const first = await buildNotePack(client as any, TEST_USER.id, 'notebook');
  const second = await buildNotePack(client as any, TEST_USER.id, 'notebook');
  expect(first.entry_count).toBe(1505);
  expect(first.sha256).toBe(second.sha256);
  const lines = first.body
    .split('\n')
    .slice(1)
    .map(line => JSON.parse(line));
  expect(lines.map(row => row.note_id)).toEqual(rows.map(row => row.id));
  for (const query of queries.filter(q =>
    q.pathname.endsWith('/notebook_notes')
  )) {
    expect(query.searchParams.get('notebook_id')).toBe('eq.notebook');
    expect(query.searchParams.get('user_id')).toBe(`eq.${TEST_USER.id}`);
    expect(query.searchParams.get('order')).toBe('sort_index.asc,id.asc');
  }
});

it('fails explicitly if an adapter ignores pagination instead of looping forever', async () => {
  await expect(
    readAllQueryPages(async () => ({ data: [{ id: 'same' }], error: null }))
  ).rejects.toThrow('did not advance');
});

it('discards earlier rows when the query factory reports an error', async () => {
  const expected = { message: 'offline' };
  const result = await readAllQueryPages(async offset =>
    offset === 0
      ? { data: [{ id: 'one' }], error: null }
      : { data: null, error: expected }
  );
  expect(result).toEqual({ data: null, error: expected });
});

it('rejects overlapping pages caused by a concurrent insert instead of returning duplicate members', async () => {
  await expect(
    readAllQueryPages(async offset => ({
      data:
        offset === 0 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'b' }, { id: 'c' }],
      error: null,
    }))
  ).rejects.toThrow('changed; retry');
});

it('list API defaults to 50 rows with an explicit continuation', async () => {
  const response = await listProblems(
    new Request('http://localhost/api/problems')
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data).toHaveLength(50);
  expect(body.pagination).toEqual({
    offset: 0,
    limit: 50,
    has_more: true,
    next_offset: 50,
  });
  expect(
    queries.every(q => q.searchParams.get('user_id') === `eq.${TEST_USER.id}`)
  ).toBe(true);
});

it('list API visits all 1505 rows without repeats even below its requested page size', async () => {
  serverCap = 37;
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const response = await listProblems(
      new Request(`http://localhost/api/problems?offset=${offset}&limit=100`)
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeLessThanOrEqual(100);
    ids.push(...body.data.map((row: { id: string }) => row.id));
    offset = body.pagination.next_offset;
  }
  expect(ids).toEqual(rows.map(row => row.id));
  expect(new Set(ids).size).toBe(1505);
});

it.each(['-1', '1.5', 'Infinity', '9007199254740992'])(
  'rejects invalid offset %s',
  async offset => {
    expect(
      (
        await listProblems(
          new Request(`http://localhost/api/problems?offset=${offset}`)
        )
      ).status
    ).toBe(400);
    expect(queries).toHaveLength(0);
  }
);

it.each(['0', '101', '2.5'])('rejects invalid limit %s', async limit => {
  expect(
    (
      await listProblems(
        new Request(`http://localhost/api/problems?limit=${limit}`)
      )
    ).status
  ).toBe(400);
});

it.each(['any', 'all'])(
  'filters tags on parent rows before selecting the page: %s',
  async mode => {
    const tag = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const response = await listProblems(
      new Request(
        `http://localhost/api/problems?tag_ids=${tag},${other}&tag_filter_mode=${mode}`
      )
    );
    expect(response.status).toBe(200);
    expect(queries.every(q => q.pathname === '/rest/v1/problems')).toBe(true);
    const query = queries[0];
    if (mode === 'any') {
      expect(query.searchParams.get('matching_tags.tag_id')).toBe(
        `in.(${tag},${other})`
      );
      expect(query.searchParams.get('matching_tags.user_id')).toBe(
        `eq.${TEST_USER.id}`
      );
    } else {
      expect(query.searchParams.get('matching_tag_0.tag_id')).toBe(`eq.${tag}`);
      expect(query.searchParams.get('matching_tag_1.tag_id')).toBe(
        `eq.${other}`
      );
      expect(query.searchParams.get('matching_tag_0.user_id')).toBe(
        `eq.${TEST_USER.id}`
      );
      expect(query.searchParams.get('matching_tag_1.user_id')).toBe(
        `eq.${TEST_USER.id}`
      );
    }
    expect(query.searchParams.get('order')).toBe('created_at.desc,id.desc');
  }
);

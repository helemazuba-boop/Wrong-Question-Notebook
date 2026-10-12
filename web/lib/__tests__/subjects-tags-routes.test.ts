import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryResult,
  request,
  params,
  TEST_USER,
  SUBJECT_ID,
  TAG_ID,
} from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  checkContentLimit: vi.fn(),
  subjects: vi.fn(),
  userTags: vi.fn(),
  subjectTags: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: () =>
    NextResponse.json({ error: 'Unauthorised' }, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/content-limits', () => ({
  checkContentLimit: mocks.checkContentLimit,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateUserSubjects: mocks.subjects,
  revalidateUserTags: mocks.userTags,
  revalidateSubjectTags: mocks.subjectTags,
}));
import {
  GET as getSubjects,
  POST as createSubject,
} from '@/app/api/subjects/route';
import {
  PATCH as updateSubject,
  DELETE as deleteSubject,
} from '@/app/api/subjects/[id]/route';
import { GET as getTags, POST as createTag } from '@/app/api/tags/route';
import {
  PATCH as updateTag,
  DELETE as deleteTag,
} from '@/app/api/tags/[id]/route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({
    user: TEST_USER,
    supabase: { from: mocks.from, rpc: mocks.rpc },
  });
  mocks.checkContentLimit.mockResolvedValue({ allowed: true });
});

describe('subjects CRUD', () => {
  it('rejects anonymous listing without running the aggregate RPC', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    expect((await getSubjects()).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('returns metadata and normalizes an empty result to a list', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ id: SUBJECT_ID, problem_count: 3 }],
      error: null,
    });
    expect((await (await getSubjects()).json()).data).toEqual([
      { id: SUBJECT_ID, problem_count: 3 },
    ]);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect((await (await getSubjects()).json()).data).toEqual([]);
  });
  it('rejects invalid creation before checking limits or writing', async () => {
    expect(
      (await createSubject(request('/api/subjects', { name: '' }))).status
    ).toBe(400);
    expect(mocks.checkContentLimit).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('does not create a subject when its content limit is exhausted', async () => {
    mocks.checkContentLimit.mockResolvedValue({ allowed: false });
    expect(
      (await createSubject(request('/api/subjects', { name: 'Math' }))).status
    ).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('uses the authenticated owner even when the request supplies another user', async () => {
    const insert = queryResult({ id: SUBJECT_ID, name: 'Math' });
    mocks.from.mockReturnValue(insert);
    expect(
      (
        await createSubject(
          request('/api/subjects', { name: 'Math', user_id: 'foreign' })
        )
      ).status
    ).toBe(201);
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: TEST_USER.id, name: 'Math' })
    );
    expect(mocks.subjects).toHaveBeenCalledWith(TEST_USER.id);
  });
  it('scopes a rename to the requested subject and current account', async () => {
    const update = queryResult({ id: SUBJECT_ID, name: 'Algebra' });
    mocks.from.mockReturnValue(update);
    expect(
      (
        await updateSubject(
          request('/api/subjects/id', { name: 'Algebra' }, 'PATCH'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(200);
    expect(update.eq).toHaveBeenCalledWith('id', SUBJECT_ID);
    expect(update.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
  });
  it('does not refresh caches or claim deletion when a delete fails', async () => {
    const deletion = queryResult(null, { message: 'foreign key violation' });
    mocks.from.mockReturnValue(deletion);
    expect(
      (
        await deleteSubject(
          request('/api/subjects/id', undefined, 'DELETE'),
          params(SUBJECT_ID)
        )
      ).status
    ).toBe(500);
    expect(deletion.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    expect(mocks.subjects).not.toHaveBeenCalled();
  });
});

describe('tags CRUD', () => {
  it.each(['', '?subject_id=invalid'])(
    'rejects missing or invalid subject filters: %s',
    async suffix => {
      expect(
        (await getTags(request(`/api/tags${suffix}`, undefined, 'GET'))).status
      ).toBe(400);
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );
  it('lists tags only for the requested subject and authenticated owner', async () => {
    const list = queryResult([{ id: TAG_ID, name: 'Functions' }]);
    mocks.from.mockReturnValue(list);
    const response = await getTags(
      request(`/api/tags?subject_id=${SUBJECT_ID}`, undefined, 'GET')
    );
    expect((await response.json()).data).toEqual([
      { id: TAG_ID, name: 'Functions' },
    ]);
    expect(list.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    expect(list.eq).toHaveBeenCalledWith('subject_id', SUBJECT_ID);
  });
  it('checks the tag limit for the specified subject before insertion', async () => {
    mocks.checkContentLimit.mockResolvedValue({ allowed: false });
    expect(
      (
        await createTag(
          request('/api/tags', { subject_id: SUBJECT_ID, name: 'Functions' })
        )
      ).status
    ).toBe(403);
    expect(mocks.checkContentLimit).toHaveBeenCalledWith(
      TEST_USER.id,
      expect.any(String),
      { subjectId: SUBJECT_ID }
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('creates a tag and refreshes both user and subject projections', async () => {
    const insert = queryResult({ id: TAG_ID });
    mocks.from.mockReturnValue(insert);
    expect(
      (
        await createTag(
          request('/api/tags', { subject_id: SUBJECT_ID, name: 'Functions' })
        )
      ).status
    ).toBe(201);
    expect(insert.insert).toHaveBeenCalledWith({
      user_id: TEST_USER.id,
      subject_id: SUBJECT_ID,
      name: 'Functions',
    });
    expect(mocks.userTags).toHaveBeenCalledWith(TEST_USER.id);
    expect(mocks.subjectTags).toHaveBeenCalledWith(SUBJECT_ID);
  });
  it.each([
    ['PATCH', updateTag],
    ['DELETE', deleteTag],
  ] as const)(
    'scopes %s to the current owner and refreshes the affected subject',
    async (method, handler) => {
      const read = queryResult({ subject_id: SUBJECT_ID });
      const write = queryResult({ id: TAG_ID, name: 'Renamed' });
      mocks.from.mockReturnValueOnce(read).mockReturnValueOnce(write);
      const response = await handler(
        request(
          '/api/tags/id',
          method === 'PATCH' ? { name: 'Renamed' } : undefined,
          method
        ),
        params(TAG_ID)
      );
      expect(response.status).toBe(200);
      expect(read.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
      expect(write.eq).toHaveBeenCalledWith('id', TAG_ID);
      expect(write.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
      expect(mocks.subjectTags).toHaveBeenCalledWith(SUBJECT_ID);
    }
  );
  it('does not acknowledge or invalidate a failed tag write', async () => {
    mocks.from
      .mockReturnValueOnce(queryResult({ subject_id: SUBJECT_ID }))
      .mockReturnValueOnce(queryResult(null, { message: 'write failed' }));
    expect(
      (
        await deleteTag(
          request('/api/tags/id', undefined, 'DELETE'),
          params(TAG_ID)
        )
      ).status
    ).toBe(500);
    expect(mocks.userTags).not.toHaveBeenCalled();
  });
});

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  readChallenge: vi.fn(),
  confirmChallenge: vi.fn(),
  revalidateProblemComprehensive: vi.fn(),
  serviceClient: {} as any,
  authenticatedClient: {} as any,
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: () =>
    NextResponse.json({ error: 'Unauthorised' }, { status: 401 }),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => mocks.serviceClient,
}));
vi.mock('@/lib/mcp-initial-idea-challenge', async importOriginal => {
  const original =
    await importOriginal<typeof import('@/lib/mcp-initial-idea-challenge')>();
  return {
    ...original,
    readMcpInitialIdeaChallenge: mocks.readChallenge,
    confirmMcpInitialIdeaChallenge: mocks.confirmChallenge,
  };
});
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemComprehensive: mocks.revalidateProblemComprehensive,
}));

import { POST, PUT } from '@/app/api/mcp/idea-confirm/[id]/route';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHALLENGE_ID = '88888888-8888-4888-8888-888888888888';
const TOKEN = 'a'.repeat(43);
const PROBLEM_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = '44444444-4444-4444-8444-444444444444';

function params() {
  return { params: Promise.resolve({ id: CHALLENGE_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  const problemBuilder: any = {};
  for (const method of ['select', 'eq']) {
    problemBuilder[method] = vi.fn(() => problemBuilder);
  }
  problemBuilder.single = vi.fn().mockResolvedValue({
    data: { subject_id: SUBJECT_ID },
    error: null,
  });
  mocks.authenticatedClient = {
    from: vi.fn(() => problemBuilder),
    rpc: vi.fn(),
  };
  mocks.serviceClient = { from: vi.fn() };
  mocks.requireUser.mockResolvedValue({
    user: { id: USER_ID },
    supabase: mocks.authenticatedClient,
  });
  mocks.readChallenge.mockResolvedValue({
    challenge_id: CHALLENGE_ID,
    problem_id: PROBLEM_ID,
    problem_title: 'Prime Numbers',
    exact_text: 'I first listed every divisor.',
    exact_text_hash: 'b'.repeat(64),
    expires_at: '2099-08-08T00:10:00.000Z',
  });
  mocks.confirmChallenge.mockResolvedValue({
    challenge_id: CHALLENGE_ID,
    problem_id: PROBLEM_ID,
    revision_id: '99999999-9999-4999-8999-999999999999',
    revision: 1,
    revision_kind: 'set',
    idea: 'I first listed every divisor.',
    channel_source: 'mcp',
    idea_origin: 'user_confirmed_external',
    replayed: false,
  });
});

describe('MCP initial idea Web confirmation route', () => {
  it('requires a cookie-authenticated owner before showing exact text', async () => {
    mocks.requireUser.mockResolvedValue({ user: null, supabase: {} });
    const response = (await PUT(
      new Request(
        `https://wqn.example.test/api/mcp/idea-confirm/${CHALLENGE_ID}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: TOKEN }),
        }
      ),
      params()
    ))!;
    expect(response.status).toBe(401);
    expect(mocks.readChallenge).not.toHaveBeenCalled();
  });

  it('binds preview to user, challenge id, and token hash', async () => {
    const response = (await PUT(
      new Request(
        `https://wqn.example.test/api/mcp/idea-confirm/${CHALLENGE_ID}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: TOKEN }),
        }
      ),
      params()
    ))!;
    expect(response.status).toBe(200);
    expect(mocks.readChallenge).toHaveBeenCalledWith(
      mocks.serviceClient,
      USER_ID,
      CHALLENGE_ID,
      expect.stringMatching(/^[0-9a-f]{64}$/)
    );
    const body = await response.json();
    expect(body.data.exact_text).toBe('I first listed every divisor.');
  });

  it('uses the authenticated RPC for the trusted second confirmation', async () => {
    const response = (await POST(
      new Request(
        `https://wqn.example.test/api/mcp/idea-confirm/${CHALLENGE_ID}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: TOKEN }),
        }
      ),
      params()
    ))!;
    expect(response.status).toBe(200);
    expect(mocks.confirmChallenge).toHaveBeenCalledWith(
      mocks.authenticatedClient,
      CHALLENGE_ID,
      TOKEN
    );
    const body = await response.json();
    expect(body.data).toMatchObject({
      channel_source: 'mcp',
      idea_origin: 'user_confirmed_external',
    });
    expect(mocks.revalidateProblemComprehensive).toHaveBeenCalledWith(
      PROBLEM_ID,
      SUBJECT_ID,
      USER_ID
    );
  });
});

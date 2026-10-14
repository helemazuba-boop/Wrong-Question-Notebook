import { beforeEach, describe, it, expect, vi } from 'vitest';
import { GET, POST } from '@/app/api/mcp/operations/[id]/route';
import { PUT } from '@/app/api/words/decks/[id]/ai-access/route';
const { requireUser, rpc, derive } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
  derive: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser,
  unauthorised: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/problem-image-service', () => ({
  deriveProblemImageAssets: derive,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemComprehensive: vi.fn(),
}));
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const context = { params: Promise.resolve({ id }) };
const req = (body: unknown) =>
  new Request(`https://wqn.example/api/mcp/operations/${id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://wqn.example',
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ user: { id: uid }, supabase: { rpc } });
  rpc.mockResolvedValue({
    data: { state: 'awaiting_approval', before: {} },
    error: null,
  });
});
describe('cookie owner review API', () => {
  it('requires a cookie user even if an MCP bearer is supplied', async () => {
    requireUser.mockResolvedValue({ user: null });
    expect(
      (
        await POST(
          req({
            kind: 'decision',
            nonce: 'a'.repeat(43),
            decision: 'approved',
          }),
          context
        )
      ).status
    ).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('issues an opaque review nonce through the authenticated client without owner inputs', async () => {
    const response = await GET(new Request('https://wqn.example'), context);
    const body = await response.json();
    expect(body.data.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rpc).toHaveBeenCalledWith('preview_mcp_operation_v2', {
      p_operation_id: id,
      p_nonce_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('approves exactly one operation using the cookie RPC and a nonce digest', async () => {
    const response = await POST(
      req({ kind: 'decision', nonce: 'a'.repeat(43), decision: 'approved' }),
      context
    );
    expect(response.status).toBe(200);
    expect(rpc.mock.calls[0]).toEqual([
      'decide_mcp_operation_v2',
      {
        p_operation_id: id,
        p_nonce_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        p_decision: 'approved',
      },
    ]);
  });
  it('reports conflicts as refresh required without auto applying', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'revision_conflict' },
    });
    const response = await POST(
      req({ kind: 'decision', nonce: 'a'.repeat(43), decision: 'approved' }),
      context
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('review_refresh_required');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects forged asset ownership before deriving storage objects', async () => {
    const response = await POST(
      req({
        kind: 'action',
        nonce: 'a'.repeat(43),
        action: 'images',
        assets: [{ path: 'user/another-owner/image.jpg' }],
        expected_revision: 1,
      }),
      context
    );
    expect(response.status).toBe(403);
    expect(derive).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects arbitrary write fields and foreign origins', async () => {
    expect(
      (
        await POST(
          req({
            kind: 'decision',
            nonce: 'a'.repeat(43),
            decision: 'approved',
            changes: { title: 'bypass' },
          }),
          context
        )
      ).status
    ).toBe(400);
    const request = new Request(
      `https://wqn.example/api/mcp/operations/${id}`,
      {
        method: 'POST',
        headers: { origin: 'https://attacker.example' },
        body: '{}',
      }
    );
    expect((await POST(request, context)).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('sets only explicitly chosen deck read/create flags through the cookie RPC', async () => {
    const response = await PUT(
      req({ can_read: true, can_create: false }),
      context
    );
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('set_word_deck_ai_access_v2', {
      p_deck_id: id,
      p_can_read: true,
      p_can_create: false,
    });
  });
  it('rejects AI update grants and foreign origins at the deck permission API', async () => {
    expect(
      (
        await PUT(
          req({ can_read: true, can_create: true, can_update: true }),
          context
        )
      ).status
    ).toBe(400);
    expect(
      (
        await PUT(
          new Request(`https://wqn.example/api/words/decks/${id}/ai-access`, {
            method: 'PUT',
            headers: { origin: 'https://attacker.example' },
            body: '{}',
          }),
          context
        )
      ).status
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});

import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, rpc, stream } = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('@/lib/esp32-device-auth', () => ({ authenticateEsp32Device: auth }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc }),
}));
vi.mock('@/app/api/esp32/ai/transcribe-chat/v2-handler', () => ({
  handleV2Streaming: stream,
}));
import { POST as chat } from '@/app/api/esp32/ai/chat/route';
import { POST as reply } from '@/app/api/esp32/ai/interactions/[id]/route';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const headers = {
  'content-type': 'application/json',
  'x-wqn-ai-tier': 'std',
  'x-wqn-request-id': '0123456789abcdef',
  'x-wqn-ai-interaction': '1',
};
const req = (body: unknown) =>
  new NextRequest('https://fixture.invalid/api/esp32/ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ userId: 'owner', deviceId: 'device' });
  rpc.mockResolvedValue({ data: { state: 'answered' }, error: null });
  stream.mockResolvedValue(new NextResponse('stream'));
});
describe('STD device routes', () => {
  it('refuses both routes before any work when authentication fails', async () => {
    auth.mockResolvedValue(new NextResponse('unauthorized', { status: 401 }));
    expect((await chat(req({ text: 'x', confirmed: true }))).status).toBe(401);
    expect(
      (
        await reply(req({ answer: 'approve', confirmed: true }), {
          params: Promise.resolve({ id }),
        })
      ).status
    ).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
  it.each([
    { text: 'unsent', confirmed: false },
    { text: 'unsent' },
    { text: '', confirmed: true },
  ])('requires an explicitly confirmed nonempty input %j', async body => {
    expect((await chat(req(body))).status).toBe(422);
    expect(stream).not.toHaveBeenCalled();
  });
  it('sends confirmed text to the chat pipeline with no audio body', async () => {
    expect((await chat(req({ text: '已确认', confirmed: true }))).status).toBe(
      200
    );
    expect(stream.mock.calls[0][2]).toMatchObject({ confirmedText: '已确认' });
    expect(stream.mock.calls[0][2].audio.byteLength).toBe(0);
  });
  it('binds a decision to authenticated ownership, not caller-supplied identities', async () => {
    expect(
      (
        await reply(
          req({ answer: 'approve', confirmed: true, user_id: 'forged' }),
          { params: Promise.resolve({ id }) }
        )
      ).status
    ).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
    expect(
      (
        await reply(req({ answer: 'approve', confirmed: true }), {
          params: Promise.resolve({ id }),
        })
      ).status
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith('reply_esp32_ai_interaction_v1', {
      p_user_id: 'owner',
      p_device_id: 'device',
      p_id: id,
      p_answer: 'approve',
    });
  });
  it('does not acknowledge a refused or expired answer', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'expired' } });
    expect(
      (
        await reply(req({ answer: 'approve', confirmed: true }), {
          params: Promise.resolve({ id }),
        })
      ).status
    ).toBe(409);
  });
});

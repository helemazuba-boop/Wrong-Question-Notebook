import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { POST } from '@/app/api/qr-sessions/[sessionId]/consume/route';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };

function chain(result: { data: unknown; error: unknown }) {
  const builder: any = {};
  for (const method of [
    'select',
    'eq',
    'gt',
    'in',
    'update',
    'single',
    'maybeSingle',
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single.mockResolvedValue(result);
  builder.maybeSingle.mockResolvedValue(result);
  return builder;
}

function setup(
  session: Record<string, unknown>,
  transition: { data: unknown; error: unknown }
) {
  const read = chain({ data: session, error: null });
  const update = chain(transition);
  const from = vi
    .fn()
    .mockImplementationOnce(() => read)
    .mockImplementationOnce(() => update);
  mocks.createServiceClient.mockReturnValue({ from });
  return { read, update, from };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ user: { id: USER_ID } });
});

describe('QR session consume route', () => {
  it('expires an uploaded session instead of returning its file', async () => {
    const { update } = setup(
      {
        user_id: USER_ID,
        status: 'uploaded',
        file_path: 'user/u/qr/photo.jpg',
        mime_type: 'image/jpeg',
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      },
      { data: null, error: null }
    );

    const response = await POST(
      new NextRequest(`http://localhost/${SESSION_ID}`, { method: 'POST' }),
      params
    );
    expect(response.status).toBe(410);
    expect(update.update).toHaveBeenCalledWith({ status: 'expired' });
  });

  it('atomically consumes only an uploaded, unexpired session', async () => {
    const { update } = setup(
      {
        user_id: USER_ID,
        status: 'uploaded',
        file_path: 'user/u/qr/photo.jpg',
        mime_type: 'image/jpeg',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        data: {
          file_path: 'user/u/qr/photo.jpg',
          mime_type: 'image/jpeg',
        },
        error: null,
      }
    );

    const response = await POST(
      new NextRequest(`http://localhost/${SESSION_ID}`, { method: 'POST' }),
      params
    );
    expect(response.status).toBe(200);
    expect(update.eq).toHaveBeenCalledWith('status', 'uploaded');
    expect(update.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('returns conflict when another consumer wins the transition', async () => {
    setup(
      {
        user_id: USER_ID,
        status: 'uploaded',
        file_path: 'user/u/qr/photo.jpg',
        mime_type: 'image/jpeg',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      { data: null, error: null }
    );

    const response = await POST(
      new NextRequest(`http://localhost/${SESSION_ID}`, { method: 'POST' }),
      params
    );
    expect(response.status).toBe(409);
  });
});

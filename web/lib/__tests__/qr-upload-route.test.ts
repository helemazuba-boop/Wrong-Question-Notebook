import crypto from 'crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { POST } from '@/app/api/qr-upload/[sessionId]/route';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = 'valid-qr-token';

function chain(result: { data: unknown; error: unknown }) {
  const builder: any = {};
  for (const method of [
    'select',
    'eq',
    'gt',
    'in',
    'update',
    'maybeSingle',
    'single',
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single.mockResolvedValue(result);
  builder.maybeSingle.mockResolvedValue(result);
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return builder;
}

function serviceFor(session: Record<string, unknown>) {
  const read = chain({ data: session, error: null });
  const update = chain({ data: { id: SESSION_ID }, error: null });
  const from = vi
    .fn()
    .mockImplementationOnce(() => read)
    .mockImplementationOnce(() => update);
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  const storageFrom = vi.fn(() => ({ upload, remove }));
  mocks.createServiceClient.mockReturnValue({
    from,
    storage: { from: storageFrom },
  });
  return { read, update, upload, remove };
}

async function png(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
    },
  })
    .png()
    .toBuffer();
}

function blobPart(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

function request(file: File, token = TOKEN, queryToken?: string) {
  const form = new FormData();
  form.set('file', file);
  const suffix = queryToken ? `?token=${queryToken}` : '';
  return new NextRequest(
    `http://localhost/api/qr-upload/${SESSION_ID}${suffix}`,
    {
      method: 'POST',
      headers: token ? { 'X-WQN-QR-Token': token } : undefined,
      body: form,
    }
  );
}

const params = { params: Promise.resolve({ sessionId: SESSION_ID }) };

beforeEach(() => vi.clearAllMocks());

describe('QR phone upload route', () => {
  it('does not accept a token from the query string', async () => {
    const file = new File([blobPart(await png())], 'photo.png', {
      type: 'image/png',
    });
    const response = await POST(request(file, '', TOKEN), params);
    expect(response.status).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('rejects declared MIME that does not match the image bytes', async () => {
    const source = await png();
    serviceFor({
      id: SESSION_ID,
      user_id: USER_ID,
      token_hash: crypto.createHash('sha256').update(TOKEN).digest('hex'),
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const response = await POST(
      request(
        new File([blobPart(source)], 'photo.jpg', { type: 'image/jpeg' })
      ),
      params
    );
    expect(response.status).toBe(400);
  });

  it('normalizes valid input and commits only while the session is unexpired', async () => {
    const source = await png();
    const { upload, update } = serviceFor({
      id: SESSION_ID,
      user_id: USER_ID,
      token_hash: crypto.createHash('sha256').update(TOKEN).digest('hex'),
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const response = await POST(
      request(new File([blobPart(source)], '相片.png', { type: 'image/png' })),
      params
    );

    expect(response.status).toBe(200);
    expect(update.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
    const [path, body, options] = upload.mock.calls[0];
    expect(path).toMatch(/\/photo-[a-f0-9]{24}\.jpg$/);
    expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: false });
    expect(await sharp(body).metadata()).toMatchObject({
      format: 'jpeg',
      width: 32,
      height: 32,
    });
  });
});

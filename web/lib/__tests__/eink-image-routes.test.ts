import { inflateSync } from 'node:zlib';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as noteImage } from '@/app/api/esp32/v3/notes/images/[noteId]/[index]/route';
import { GET as problemImage } from '@/app/api/esp32/v3/problems/images/[problemId]/[kind]/[index]/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { mockAuthenticate, mockDownload, mockFrom } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockDownload: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('@/lib/device-control-v3-auth', () => ({
  authenticateDeviceControlV3: mockAuthenticate,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({
    from: mockFrom,
    storage: { from: () => ({ download: mockDownload }) },
  }),
}));

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const PROBLEM_ID = '22222222-2222-4222-8222-222222222222';
const BW_ID = 'a'.repeat(64);
const GRAY_ID = 'b'.repeat(64);
const BYTES = Buffer.from('wqni-gray4');

function request(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: {
      authorization: `Bearer ${'c'.repeat(64)}`,
      'user-agent': 'vitest-eink-image',
      'x-forwarded-for': '127.0.0.1',
      'x-wqn-protocol': '3',
      'x-wqn-request-id': 'req_eink_image_route_01',
    },
  });
}

function queryResult(data: unknown) {
  const chain: Record<string, any> = {};
  const fluent = vi.fn(() => chain);
  chain.select = fluent;
  chain.eq = fluent;
  chain.is = fluent;
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return chain;
}

beforeEach(() => {
  _resetRateLimitStore();
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: USER_ID });
  mockDownload.mockResolvedValue({
    data: new Blob([BYTES]),
    error: null,
  });
});

describe('device WQNI image variants', () => {
  it('serves a note gray4 derivative and identifies the selected variant', async () => {
    mockFrom.mockReturnValue(
      queryResult({
        assets: [
          {
            image_id: BW_ID,
            display_path: 'bw.wqni',
            gray4_image_id: GRAY_ID,
            gray4_display_path: 'gray4.wqni',
          },
        ],
      })
    );
    const response = await noteImage(
      request(`/api/esp32/v3/notes/images/${NOTE_ID}/0?pixel_format=gray4`),
      { params: Promise.resolve({ noteId: NOTE_ID, index: '0' }) }
    );

    expect(response.status).toBe(200);
    expect(mockDownload).toHaveBeenCalledWith('gray4.wqni');
    expect(response.headers.get('X-WQN-Image-Id')).toBe(GRAY_ID);
    expect(response.headers.get('X-WQN-Pixel-Format')).toBe('gray4');
    expect(inflateSync(Buffer.from(await response.arrayBuffer()))).toEqual(
      BYTES
    );
  });

  it('keeps BW1 as the default for old firmware', async () => {
    mockFrom.mockReturnValue(
      queryResult({
        assets: [{ image_id: BW_ID, display_path: 'bw.wqni' }],
      })
    );
    const response = await noteImage(
      request(`/api/esp32/v3/notes/images/${NOTE_ID}/0`),
      { params: Promise.resolve({ noteId: NOTE_ID, index: '0' }) }
    );

    expect(response.status).toBe(200);
    expect(mockDownload).toHaveBeenCalledWith('bw.wqni');
    expect(response.headers.get('X-WQN-Pixel-Format')).toBe('bw1');
  });

  it('reports an unavailable gray derivative without substituting bytes', async () => {
    mockFrom.mockReturnValue(
      queryResult({
        assets: [{ image_id: BW_ID, display_path: 'bw.wqni' }],
      })
    );
    const response = await noteImage(
      request(`/api/esp32/v3/notes/images/${NOTE_ID}/0?pixel_format=gray4`),
      { params: Promise.resolve({ noteId: NOTE_ID, index: '0' }) }
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('IMAGE_VARIANT_NOT_FOUND');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('selects the aligned problem solution gray4 derivative', async () => {
    mockFrom.mockReturnValue(
      queryResult({
        assets: [],
        solution_assets: [
          { kind: 'pdf', path: 'ignored.pdf' },
          {
            image_id: BW_ID,
            display_path: 'solution-bw.wqni',
            gray4_image_id: GRAY_ID,
            gray4_display_path: 'solution-gray4.wqni',
          },
        ],
      })
    );
    const response = await problemImage(
      request(
        `/api/esp32/v3/problems/images/${PROBLEM_ID}/solution/0?pixel_format=gray4`
      ),
      {
        params: Promise.resolve({
          problemId: PROBLEM_ID,
          kind: 'solution',
          index: '0',
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(mockDownload).toHaveBeenCalledWith('solution-gray4.wqni');
    expect(response.headers.get('X-WQN-Image-Id')).toBe(GRAY_ID);
  });

  it('rejects unknown pixel formats before querying storage', async () => {
    const response = await problemImage(
      request(
        `/api/esp32/v3/problems/images/${PROBLEM_ID}/assets/0?pixel_format=rgb`
      ),
      {
        params: Promise.resolve({
          problemId: PROBLEM_ID,
          kind: 'assets',
          index: '0',
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

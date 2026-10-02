import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  upload: vi.fn(),
  renderEinkImage: vi.fn(),
}));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({ download: mocks.download, upload: mocks.upload }),
    },
  }),
}));
vi.mock('@/lib/eink-image', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/eink-image')>()),
  renderEinkImage: mocks.renderEinkImage,
}));

import {
  EINK_DERIVATION_PIPELINE_VERSION,
  renderEinkDerivations,
} from '@/lib/eink-derivation-service';

const BW_ID = 'a'.repeat(64);
const GRAY_ID = 'b'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.download.mockResolvedValue({
    data: new Blob([new Uint8Array([1, 2, 3])]),
    error: null,
  });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.renderEinkImage.mockResolvedValue({
    imageId: BW_ID,
    gray4ImageId: GRAY_ID,
    wqni: Buffer.from('bw'),
    preview: Buffer.from('bw-preview'),
    gray4Wqni: Buffer.from('gray'),
    gray4Preview: Buffer.from('gray-preview'),
  });
});

describe('e-ink derivation publication', () => {
  it('publishes all variants as immutable content-addressed objects', async () => {
    const asset = await renderEinkDerivations(
      'user/u/original',
      'user/u/derived'
    );

    expect(asset).toMatchObject({
      pipeline_version: EINK_DERIVATION_PIPELINE_VERSION,
      image_id: BW_ID,
      gray4_image_id: GRAY_ID,
    });
    expect(mocks.upload).toHaveBeenCalledTimes(4);
    for (const call of mocks.upload.mock.calls) {
      expect(call[2]).toMatchObject({ upsert: false });
    }
  });

  it('treats an existing immutable object as idempotent success', async () => {
    mocks.upload.mockResolvedValue({
      error: {
        message: 'The resource already exists',
        status: 409,
        statusCode: '409',
      },
    });

    await expect(
      renderEinkDerivations('user/u/original', 'user/u/derived')
    ).resolves.toMatchObject({ image_id: BW_ID });
  });

  it('waits for every publication before surfacing a storage failure', async () => {
    mocks.upload
      .mockResolvedValueOnce({ error: { message: 'offline', status: 500 } })
      .mockResolvedValue({ error: null });

    await expect(
      renderEinkDerivations('user/u/original', 'user/u/derived')
    ).rejects.toMatchObject({ code: 'storage_error' });
    expect(mocks.upload).toHaveBeenCalledTimes(4);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  DeviceContentArtifactError,
  registerDeviceImageArtifacts,
} from '@/lib/device-content-artifacts';

function makeClient(input?: {
  existing?: Array<{ image_id: string; storage_path: string }>;
  copyError?: { message: string } | null;
}) {
  const copy = vi.fn().mockResolvedValue({
    data: input?.copyError ? null : { path: 'copied' },
    error: input?.copyError ?? null,
  });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn().mockResolvedValue({
      data: input?.existing ?? [],
      error: null,
    }),
    upsert,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const client = {
    from: vi.fn().mockReturnValue(query),
    storage: {
      from: vi.fn().mockReturnValue({ copy }),
    },
  };
  return { client: client as any, copy, upsert };
}

describe('device image artifacts', () => {
  it('copies attachment WQNI files into immutable content-addressed paths', async () => {
    const { client, copy, upsert } = makeClient();
    const bwId = 'a'.repeat(64);
    const grayId = 'b'.repeat(64);

    await registerDeviceImageArtifacts(client, 'user-1', [
      [
        {
          image_id: bwId,
          display_path: 'user/user-1/notes/n1/derived/source.wqni',
          gray4_image_id: grayId,
          gray4_display_path: 'user/user-1/notes/n1/derived/source.gray4.wqni',
        },
      ],
    ]);

    expect(copy).toHaveBeenCalledTimes(2);
    expect(copy).toHaveBeenCalledWith(
      'user/user-1/notes/n1/derived/source.wqni',
      `user/user-1/device-images/bw1/${bwId}.wqni`
    );
    expect(copy).toHaveBeenCalledWith(
      'user/user-1/notes/n1/derived/source.gray4.wqni',
      `user/user-1/device-images/gray4/${grayId}.wqni`
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          image_id: bwId,
          storage_path: `user/user-1/device-images/bw1/${bwId}.wqni`,
        }),
        expect.objectContaining({
          image_id: grayId,
          storage_path: `user/user-1/device-images/gray4/${grayId}.wqni`,
        }),
      ]),
      { onConflict: 'user_id,image_id' }
    );
  });

  it('does not copy an artifact already materialized at its immutable path', async () => {
    const imageId = 'c'.repeat(64);
    const immutablePath = `user/user-1/device-images/bw1/${imageId}.wqni`;
    const { client, copy } = makeClient({
      existing: [{ image_id: imageId, storage_path: immutablePath }],
    });

    await registerDeviceImageArtifacts(client, 'user-1', [
      [
        {
          image_id: imageId,
          display_path: 'user/user-1/problems/p1/derived/source.wqni',
        },
      ],
    ]);

    expect(copy).not.toHaveBeenCalled();
  });

  it('does not publish a lookup row when the immutable copy fails', async () => {
    const imageId = 'd'.repeat(64);
    const { client, upsert } = makeClient({
      copyError: { message: 'source object missing' },
    });

    await expect(
      registerDeviceImageArtifacts(client, 'user-1', [
        [
          {
            image_id: imageId,
            display_path: 'user/user-1/notes/n1/derived/missing.wqni',
          },
        ],
      ])
    ).rejects.toBeInstanceOf(DeviceContentArtifactError);
    expect(upsert).not.toHaveBeenCalled();
  });
});

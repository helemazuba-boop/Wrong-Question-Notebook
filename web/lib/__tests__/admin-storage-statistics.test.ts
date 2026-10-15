import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), bucket: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ storage: { from: mocks.bucket } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
import {
  getTotalStorageUsage,
  getUserStorageUsage,
} from '@/lib/user-management';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.bucket.mockReturnValue({ list: mocks.list });
});

describe('admin storage statistics', () => {
  it('counts empty files and recursively includes nested files', async () => {
    mocks.list.mockImplementation(async (path: string) => ({
      data:
        path === ''
          ? [
              { name: 'folder', id: null, metadata: null },
              { name: 'empty.txt', id: 'empty', metadata: { size: 0 } },
            ]
          : [{ name: 'note.png', id: 'note', metadata: { size: 17 } }],
      error: null,
    }));
    expect(await getTotalStorageUsage()).toEqual({
      totalBytes: 17,
      fileCount: 2,
    });
    expect(mocks.list).toHaveBeenCalledWith(
      'folder',
      expect.objectContaining({ offset: 0 })
    );
  });

  it('reads beyond the storage API page limit', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      name: `file-${index}`,
      id: String(index),
      metadata: { size: 1 },
    }));
    mocks.list
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({
        data: [{ name: 'last', id: 'last', metadata: { size: 2 } }],
        error: null,
      });
    expect(await getTotalStorageUsage()).toEqual({
      totalBytes: 1002,
      fileCount: 1001,
    });
    expect(mocks.list).toHaveBeenLastCalledWith(
      '',
      expect.objectContaining({ offset: 1000, limit: 1000 })
    );
  });

  it('keeps per-user statistics scoped to their existing storage prefix', async () => {
    mocks.list.mockResolvedValue({ data: [], error: null });
    expect(await getUserStorageUsage('owner')).toEqual({
      totalBytes: 0,
      fileCount: 0,
    });
    expect(mocks.list).toHaveBeenCalledWith('user/owner', expect.any(Object));
  });

  it('does not return partial or zero totals after a listing failure', async () => {
    mocks.list.mockResolvedValue({ data: null, error: { message: 'offline' } });
    await expect(getTotalStorageUsage()).rejects.toThrow(
      'Storage statistics are unavailable'
    );
  });

  it('does not substitute a file size when metadata is missing', async () => {
    mocks.list.mockResolvedValue({
      data: [{ name: 'incomplete', id: 'file', metadata: null }],
      error: null,
    });
    await expect(getTotalStorageUsage()).rejects.toThrow(
      'Storage file size is unavailable'
    );
  });
});

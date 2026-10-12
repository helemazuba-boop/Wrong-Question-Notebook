import { describe, expect, it, vi } from 'vitest';
import { queryResult } from '@/lib/test/supabase-query';
vi.mock('server-only', () => ({}));
import {
  recentlyAuthenticated,
  safeStoragePath,
  deleteAccount,
  processAccountDataJobs,
} from '@/lib/account-data';
const job = {
  id: 'job',
  user_id: 'user',
  kind: 'delete' as const,
  status: 'running',
  attempts: 1,
  lease_id: 'lease',
  archive_path: null,
  expires_at: null,
};
describe('account data safety and recovery', () => {
  it('requires a recent actual authentication method rather than a refreshed JWT iat', () => {
    const now = Date.now();
    expect(recentlyAuthenticated({ iat: now / 1000 }, now)).toBe(false);
    expect(
      recentlyAuthenticated(
        {
          amr: [{ method: 'password', timestamp: now / 1000 - 301 }],
          iat: now / 1000,
        },
        now
      )
    ).toBe(false);
    expect(
      recentlyAuthenticated(
        { amr: [{ method: 'password', timestamp: now / 1000 - 1 }] },
        now
      )
    ).toBe(true);
    expect(
      recentlyAuthenticated(
        { amr: [{ method: 'token_refresh', timestamp: now / 1000 }] },
        now
      )
    ).toBe(false);
  });
  it('rejects storage paths that could escape the export directory', () => {
    for (const path of [
      '/absolute',
      'user/../secret',
      'user/./secret',
      'user\\secret',
      'user//secret',
      'user/\u0000secret',
    ])
      expect(safeStoragePath(path)).toBe(false);
    expect(safeStoragePath('user/uuid/notes/image.png')).toBe(true);
  });
  it('does not delete the Auth identity after a failed storage cleanup', async () => {
    const remove = vi.fn().mockResolvedValue({ error: { message: 'offline' } }),
      deleteUser = vi.fn();
    const client = {
      rpc: vi.fn().mockImplementation((name: string) =>
        Promise.resolve({
          data:
            name === 'account_storage_objects'
              ? [{ bucket: 'avatars', path: 'user/avatar' }]
              : [],
          error: null,
        })
      ),
      from: () => ({ update: () => queryResult({ id: 'job' }) }),
      storage: { from: () => ({ remove }) },
      auth: { admin: { deleteUser } },
    } as any;
    await expect(deleteAccount(client, job)).rejects.toThrow(
      'attachment deletion'
    );
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it('does not reclassify a cleanup failure as completed and leaves deletion retryable', async () => {
    const update = vi.fn(() => queryResult({ id: 'job' }));
    const client = {
      rpc: vi
        .fn()
        .mockImplementation((name: string) =>
          Promise.resolve(
            name === 'claim_account_data_job'
              ? { data: [{ ...job, attempts: 4 }], error: null }
              : { data: null, error: { message: 'offline' } }
          )
        ),
      from: () => ({ update }),
    } as any;
    expect(await processAccountDataJobs(client)).toEqual({
      processed: 1,
      status: 'pending',
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        last_error: 'Account storage inventory failed',
      })
    );
  });
});

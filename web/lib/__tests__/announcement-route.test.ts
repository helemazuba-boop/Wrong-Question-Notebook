import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getAnnouncement: vi.fn() }));
vi.mock('@/lib/user-management', () => ({
  getAnnouncement: mocks.getAnnouncement,
}));
import { GET } from '@/app/api/announcement/route';

beforeEach(() => vi.resetAllMocks());
describe('public announcement route', () => {
  it('returns the configured announcement', async () => {
    const announcement = { text: 'Scheduled maintenance', enabled: true };
    mocks.getAnnouncement.mockResolvedValue(announcement);
    expect(await (await GET()).json()).toEqual({ announcement });
  });
  it('returns null when no announcement is enabled', async () => {
    mocks.getAnnouncement.mockResolvedValue(null);
    expect(await (await GET()).json()).toEqual({ announcement: null });
  });
  it('keeps the app shell usable when announcement lookup throws', async () => {
    mocks.getAnnouncement.mockRejectedValue(new Error('database unavailable'));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ announcement: null });
  });
});

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { loadVoiceContext } from '@/lib/ai-tools/voice-context-server';
const { notebooks } = vi.hoisted(() => ({ notebooks: vi.fn() }));
vi.mock('@/lib/notebooks', () => ({ listAuthorizedNotebooks: notebooks }));
function ctx(profile: any) {
  const q: any = {};
  q.select = q.eq = () => q;
  q.maybeSingle = async () => profile;
  return { userId: 'owner', supabase: { from: () => q } } as any;
}
beforeEach(() => {
  notebooks.mockResolvedValue({ notebooks: [] });
});
describe('injected notebook and clock context', () => {
  it('injects only create-authorized targets without extra model tool calls', async () => {
    notebooks.mockResolvedValue({
      notebooks: [
        {
          id: 'a',
          title: 'Math',
          subject_name: 'Math',
          permissions: { can_create: true },
        },
        { id: 'b', title: 'Read only', permissions: { can_create: false } },
      ],
    });
    expect(
      await loadVoiceContext(
        ctx({
          data: { timezone: 'Asia/Shanghai', is_active: true },
          error: null,
        }),
        '2026-10-14T00:00:00Z'
      )
    ).toMatchObject({
      timezone: 'Asia/Shanghai',
      timezone_available: true,
      notebooks: [{ id: 'a', title: 'Math' }],
    });
  });
  it('reports unavailable permission and timezone snapshots explicitly', async () => {
    notebooks.mockRejectedValue(new Error('DB unavailable'));
    expect(
      await loadVoiceContext(ctx({ data: null, error: { message: 'down' } }))
    ).toMatchObject({
      timezone_available: false,
      notebooks_available: false,
      notebooks: [],
    });
  });
  it('does not inject a disabled account context', async () => {
    await expect(
      loadVoiceContext(ctx({ data: { is_active: false }, error: null }))
    ).rejects.toThrow('disabled');
  });
});

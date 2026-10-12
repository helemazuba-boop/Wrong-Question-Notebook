import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('login');
  },
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: any) => createElement('a', { href }, children),
}));
vi.mock('@/components/page-header', () => ({ PageHeader: () => null }));
import NotebooksPage from '@/app/[locale]/(app)/notebooks/page';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({
    user: TEST_USER,
    supabase: { from: mocks.from },
  });
});
describe('notebook library ownership and pagination', () => {
  it('requires authentication before querying notebooks', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    await expect(
      NotebooksPage({ searchParams: Promise.resolve({}) })
    ).rejects.toThrow('login');
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('lists only this account, excludes archives, and preserves the return source', async () => {
    const read = queryResult(
      [
        {
          id: 'notebook',
          title: 'Owned notebook',
          description: '',
          subjects: null,
        },
      ],
      null,
      101
    );
    mocks.from.mockReturnValue(read);
    const html = renderToStaticMarkup(
      await NotebooksPage({ searchParams: Promise.resolve({ page: '2' }) })
    );
    expect(read.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    expect(read.is).toHaveBeenCalledWith('archived_at', null);
    expect(read.range).toHaveBeenCalledWith(50, 99);
    expect(html).toContain('Owned notebook');
    expect(html).toContain('from=');
    expect(html).toContain('/notebooks?page=3');
  });
  it('does not present database failure as an empty library', async () => {
    mocks.from.mockReturnValue(queryResult(null, { message: 'offline' }));
    await expect(
      NotebooksPage({ searchParams: Promise.resolve({}) })
    ).rejects.toThrow('unavailable');
  });
});

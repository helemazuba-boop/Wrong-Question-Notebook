import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ locale: vi.fn(), redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: mocks.locale }));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));
import NotebooksPage from '@/app/[locale]/(app)/notebooks/page';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.redirect.mockImplementation(() => {
    throw new Error('redirect');
  });
});

describe('legacy notebook list redirects to the unified shelf', () => {
  it.each(['en', 'zh-CN'])('preserves the %s locale', async locale => {
    mocks.locale.mockResolvedValue(locale);
    await expect(NotebooksPage()).rejects.toThrow('redirect');
    expect(mocks.redirect).toHaveBeenCalledWith({
      href: '/subjects',
      locale,
    });
  });
});

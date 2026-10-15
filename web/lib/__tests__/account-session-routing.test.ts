import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { queryResult, TEST_USER } from '@/lib/test/supabase-query';

const state = vi.hoisted(() => ({
  active: false,
  valid: true,
  client: null as any,
  jobs: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => state.client }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => state.client,
}));
vi.mock('@/lib/server-utils', () => ({ hasEnvVars: true }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return {
    default: () => (req: NextRequest) => {
      const response = NextResponse.next();
      response.headers.set(
        'x-next-intl-locale',
        req.nextUrl.pathname.split('/')[1]
      );
      return response;
    },
  };
});
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock('@/components/login-form', () => ({ LoginForm: () => null }));
vi.mock('@/components/account-data-client', () => ({
  AccountDataClient: () => null,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: state.jobs }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
import {
  getAuthenticatedPrincipal,
  getVerifiedPrincipal,
} from '@/lib/supabase/auth-principal';
import { proxy } from '@/proxy';
import LoginPage from '@/app/[locale]/auth/login/page';
import AccountPage from '@/app/[locale]/(app)/account/page';
import { GET as status, POST as enqueue } from '@/app/api/account/data/route';

beforeEach(() => {
  vi.clearAllMocks();
  state.active = false;
  state.valid = true;
  state.client = {
    auth: {
      getClaims: vi.fn(async () =>
        state.valid
          ? {
              data: { claims: { sub: TEST_USER.id, email: TEST_USER.email } },
              error: null,
            }
          : { data: null, error: new Error('invalid JWT') }
      ),
    },
    from: vi.fn(() => queryResult({ is_active: state.active })),
  };
});
const request = (path: string) =>
  new NextRequest(`https://example.invalid${path}`);

describe('account status access during deletion', () => {
  it('verifies the identity without granting inactive business access', async () => {
    expect((await getVerifiedPrincipal(state.client)).user).toEqual(TEST_USER);
    expect(state.client.from).not.toHaveBeenCalled();
    expect((await getAuthenticatedPrincipal(state.client)).user).toBeNull();
  });
  it.each(['en', 'zh-CN'])(
    'allows an inactive owner to refresh the exact %s account page',
    async locale => {
      const response = await proxy(request(`/${locale}/account`));
      expect(response.headers.get('location')).toBeNull();
      expect((await AccountPage()).props.active).toBe(false);
    }
  );
  it.each([
    '/en/subjects',
    '/en/todos',
    '/en/admin',
    '/en/account/other',
    '/en/accounting',
  ])('continues to protect %s from inactive sessions', async path => {
    expect((await proxy(request(path))).headers.get('location')).toContain(
      '/en/auth/login'
    );
  });
  it('sends an inactive login session to its status page instead of the requested business route', async () => {
    await expect(
      LoginPage({ searchParams: Promise.resolve({ redirect: '/todos' }) })
    ).rejects.toThrow('redirect:/account');
    expect(
      (await proxy(request('/en/account'))).headers.get('location')
    ).toBeNull();
  });
  it('preserves explicit reauthentication and active-account redirects', async () => {
    await expect(
      LoginPage({ searchParams: Promise.resolve({ reauth: '1' }) })
    ).resolves.toBeTruthy();
    state.active = true;
    await expect(
      LoginPage({
        searchParams: Promise.resolve({ redirect: '/todos?view=today' }),
      })
    ).rejects.toThrow('redirect:/todos?view=today');
  });
  it('requires a verified JWT even on the account status page', async () => {
    state.valid = false;
    expect(
      (await proxy(request('/en/account'))).headers.get('location')
    ).toContain('/en/auth/login');
    await expect(AccountPage()).rejects.toThrow(
      'redirect:/auth/login?redirect=/account'
    );
    await expect(
      LoginPage({ searchParams: Promise.resolve({}) })
    ).resolves.toBeTruthy();
  });
  it('limits the inactive status API to its own jobs and refuses a new write', async () => {
    const query = queryResult([
      { id: 'job', kind: 'delete', status: 'pending' },
    ]);
    state.jobs.mockReturnValue(query);
    expect((await status(request('/api/account/data'))).status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    state.jobs.mockClear();
    expect((await enqueue(request('/api/account/data'))).status).toBe(401);
    expect(state.jobs).not.toHaveBeenCalled();
  });
});

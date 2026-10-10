import { test, expect } from './fixtures';
import { login } from './global-setup';
import { randomUUID } from 'node:crypto';

test('protected route, real login, refresh and logout', async ({
  browser,
  data,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const credentials = {
    email: `e2e-auth-${randomUUID()}@example.invalid`,
    password: randomUUID(),
  };
  const { data: created, error } = await data.admin.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  expect(error).toBeNull();
  const userId = created.user!.id;
  const { error: profileError } = await data.admin
    .from('user_profiles')
    .update({
      onboarding_completed_at: new Date().toISOString(),
      timezone: 'Asia/Shanghai',
    })
    .eq('id', userId);
  expect(profileError).toBeNull();
  try {
    const page = await context.newPage();
    await page.goto('/en/subjects');
    await expect(page).toHaveURL(/\/auth\/login\?redirect=/);
    await login(page, credentials.email, credentials.password);
    await expect(page).toHaveURL(/\/en\/subjects/);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Open profile' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open profile' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/en\/?$/);
    await page.goto('/en/subjects');
    await expect(page).toHaveURL(/\/auth\/login/);
  } finally {
    await context.close();
    const { error: deleteError } =
      await data.admin.auth.admin.deleteUser(userId);
    expect(deleteError).toBeNull();
  }
});

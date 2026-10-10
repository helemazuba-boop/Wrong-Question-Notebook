import { test, expect } from './fixtures';
import { login } from './global-setup';

test('protected route, real login, refresh and logout', async ({
  browser,
  data,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await context.newPage();
    await page.goto('/en/notebooks');
    await expect(page).toHaveURL(/\/auth\/login\?redirect=/);
    await login(page, data.accounts.a.email, data.accounts.a.password);
    await expect(page).toHaveURL(/\/en\/notebooks/);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Open profile' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open profile' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/en\/?$/);
    await page.goto('/en/notebooks');
    await expect(page).toHaveURL(/\/auth\/login/);
  } finally {
    await context.close();
  }
});

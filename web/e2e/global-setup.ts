import { chromium, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export async function login(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).not.toHaveURL(/\/auth\/login/);
}

export default async function globalSetup() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (url !== 'https://supabase.e2e.test:8444' || !key)
    throw new Error('E2E requires the isolated local Supabase environment');
  // Linux Firefox uses its own certificate store. Install only our ephemeral
  // test CA through its documented policy; TLS verification remains enabled.
  const policyFile = process.env.PLAYWRIGHT_FIREFOX_POLICIES_JSON;
  if (!policyFile)
    throw new Error('E2E requires the ephemeral Firefox certificate policy');
  await writeFile(
    policyFile,
    JSON.stringify({
      policies: {
        Certificates: { Install: [path.resolve('../.ci-local/certs/ca.crt')] },
      },
    })
  );
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const directory = path.resolve('../.ci-local/auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch();
  const accounts: Record<
    string,
    { id: string; email: string; password: string }
  > = {};
  try {
    for (const name of ['a', 'b']) {
      const email = `e2e-${name}-${randomBytes(6).toString('hex')}@example.invalid`;
      const password = randomBytes(24).toString('base64url');
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user)
        throw error || new Error('Failed to create a test user');
      const { error: profileError } = await admin
        .from('user_profiles')
        .update({
          onboarding_completed_at: new Date().toISOString(),
          timezone: 'Asia/Shanghai',
        })
        .eq('id', data.user.id);
      if (profileError) throw profileError;
      accounts[name] = { id: data.user.id, email, password };
      const context = await browser.newContext({
        baseURL: process.env.WQN_E2E_BASE_URL,
      });
      const page = await context.newPage();
      const response = await page.goto('/en/auth/login?redirect=/subjects');
      try {
        await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
      } catch (error) {
        await mkdir('test-results', { recursive: true });
        await page.screenshot({
          path: 'test-results/setup-login.png',
          fullPage: true,
        });
        console.error('Login page diagnostic', {
          status: response?.status(),
          url: page.url(),
          title: await page.title(),
          text: (await page.locator('body').innerText()).slice(0, 2000),
        });
        throw error;
      }
      await login(page, email, password);
      await expect(page).toHaveURL(/\/en\/subjects/);
      const rejectCookies = page.getByRole('button', {
        name: 'Reject all',
        exact: true,
      });
      await rejectCookies.click();
      await expect(rejectCookies).toBeHidden();
      await context.storageState({
        path: path.join(directory, `${name}.json`),
      });
      await context.close();
    }
    await writeFile(
      path.join(directory, 'accounts.json'),
      JSON.stringify(accounts),
      { mode: 0o600 }
    );
  } finally {
    await browser.close();
  }
}

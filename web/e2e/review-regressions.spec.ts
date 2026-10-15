import { test as base, expect, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import {
  getFilteredProblems,
  getFilteredProblemsCount,
} from '../lib/review-utils';
import type { FilterConfig } from '../lib/types';
import en from '../messages/en.json';
import zh from '../messages/zh-CN.json';

type Data = {
  admin: SupabaseClient;
  id: string;
  email: string;
  password: string;
};
const test = base.extend<{ data: Data }>({
  data: async ({ request }, provide) => {
    expect((await request.get('/api/health')).ok()).toBeTruthy();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    if (
      !['127.0.0.1', 'localhost', 'supabase.e2e.test'].includes(
        new URL(url).hostname
      )
    )
      throw new Error('Review regressions require an isolated local Supabase');
    const admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `review-${randomUUID()}@example.invalid`,
      password = randomUUID();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error).toBeNull();
    const id = created.data.user!.id;
    try {
      expect(
        (
          await admin
            .from('user_profiles')
            .update({ onboarding_completed_at: new Date().toISOString() })
            .eq('id', id)
        ).error
      ).toBeNull();
      await provide({ admin, id, email, password });
    } finally {
      for (const [table, column] of [
        ['problem_set_reports', 'reporter_user_id'],
        ['subjects', 'user_id'],
        ['account_data_jobs', 'user_id'],
      ])
        expect(
          (await admin.from(table).delete().eq(column, id)).error
        ).toBeNull();
      expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();
    }
  },
});
test.use({ storageState: { cookies: [], origins: [] } });
async function login(page: Page, data: Data) {
  await page.goto('/en/auth/login?redirect=/account');
  // Wait for a working form interaction before filling controlled inputs.
  // WebKit can expose SSR controls before their event handlers are attached.
  const password = page.getByLabel('Password', { exact: true });
  await expect(async () => {
    await page
      .getByRole('button', { name: 'Show password', exact: true })
      .click();
    await expect(password).toHaveAttribute('type', 'text', { timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await page
    .getByRole('button', { name: 'Hide password', exact: true })
    .click();
  await page.getByLabel('Email', { exact: true }).fill(data.email);
  await page.getByLabel('Password', { exact: true }).fill(data.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/en/account');
  await expect(
    page.getByRole('heading', { name: en.AccountData.title, exact: true })
  ).toBeVisible();
  const consent = page.getByRole('button', { name: 'Reject all', exact: true });
  if (await consent.isVisible()) await consent.click();
}

test('queued deletion survives reload and login while business writes remain blocked', async ({
  page,
  data,
}) => {
  await login(page, data);
  const queued = await page.evaluate(async () => {
    const response = await fetch('/api/account/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'delete', confirm: true }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(queued.status).toBe(202);
  for (const locale of ['en', 'zh-CN'] as const) {
    await page.goto(`/${locale}/account`);
    await expect(page).toHaveURL(new RegExp(`/${locale}/account$`));
    const pending = (locale === 'en' ? en : zh).AccountData.deletionPending;
    await expect(page.getByText(pending, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(pending, { exact: true })).toBeVisible();
    const progress = await page.request.get('/api/account/data');
    expect(progress.status()).toBe(200);
    expect(
      (await progress.json()).jobs.map((job: { id: string }) => job.id)
    ).toEqual([queued.body.id]);
  }
  expect(
    (
      await page.request.post('/api/todos', {
        data: { title: 'Must be refused' },
      })
    ).status()
  ).toBe(401);
  await page.goto('/en/auth/login?redirect=/todos');
  await expect(page).toHaveURL(/\/account$/);
  await page.goto('/en/todos');
  await expect(page).toHaveURL(/\/account$/);
});

test('admin dashboard actions follow the current role in both languages', async ({
  page,
  data,
}) => {
  await login(page, data);
  await page.setViewportSize({ width: 1664, height: 928 });
  for (const role of ['admin', 'super_admin', 'admin']) {
    expect(
      (
        await data.admin
          .from('user_profiles')
          .update({ user_role: role })
          .eq('id', data.id)
      ).error
    ).toBeNull();
    for (const locale of ['en', 'zh-CN'] as const) {
      await page.goto(`/${locale}/admin`);
      const actions = page
        .getByRole('heading', {
          name: locale === 'en' ? 'Quick Actions' : '快捷操作',
          exact: true,
        })
        .locator('..');
      await expect(actions.getByRole('link')).toHaveCount(
        role === 'super_admin' ? 5 : 2
      );
      for (const path of ['announcements', 'settings', 'problem-marks'])
        await expect(actions.locator(`a[href$="/admin/${path}"]`)).toHaveCount(
          role === 'super_admin' ? 1 : 0
        );
    }
  }
});

test('tagged smart reports expose every page beyond 1000 matching problems', async ({
  page,
  data,
}) => {
  const subject = randomUUID(),
    set = randomUUID(),
    report = randomUUID(),
    tag = randomUUID(),
    secondTag = randomUUID();
  const ids = Array.from({ length: 1101 }, () => randomUUID())
    .sort()
    .reverse();
  const filter: FilterConfig = {
    tag_ids: [tag, secondTag],
    statuses: [],
    problem_types: [],
    include_never_reviewed: true,
  };
  expect(
    (
      await data.admin
        .from('user_profiles')
        .update({ user_role: 'moderator' })
        .eq('id', data.id)
    ).error
  ).toBeNull();
  expect(
    (
      await data.admin.from('subjects').insert({
        id: subject,
        user_id: data.id,
        name: 'Pagination regression',
      })
    ).error
  ).toBeNull();
  expect(
    (
      await data.admin.from('tags').insert(
        [tag, secondTag].map(id => ({
          id,
          user_id: data.id,
          subject_id: subject,
          name: id,
        }))
      )
    ).error
  ).toBeNull();
  for (let offset = 0; offset < ids.length; offset += 250) {
    const batch = ids.slice(offset, offset + 250);
    expect(
      (
        await data.admin.from('problems').insert(
          batch.map(id => ({
            id,
            user_id: data.id,
            subject_id: subject,
            title: 'Tagged problem',
            content: 'Review fixture',
            parts: [
              {
                index: 1,
                type: 'single_choice',
                content: 'Pick one',
                answer_config: {
                  type: 'mcq',
                  choices: [{ id: 'A', text: 'Fixture' }],
                  correct_choice_id: 'A',
                },
              },
            ],
            status: 'needs_review',
            created_at: '2026-10-15T00:00:00Z',
          }))
        )
      ).error
    ).toBeNull();
    expect(
      (
        await data.admin.from('problem_tag').insert(
          batch.flatMap((id, index) =>
            [tag, ...(index % 2 === 0 ? [secondTag] : [])].map(tag_id => ({
              user_id: data.id,
              problem_id: id,
              tag_id,
            }))
          )
        )
      ).error
    ).toBeNull();
  }
  expect(
    (
      await data.admin.from('problem_sets').insert({
        id: set,
        user_id: data.id,
        subject_id: subject,
        name: 'Smart regression',
        is_smart: true,
        filter_config: filter,
      })
    ).error
  ).toBeNull();
  expect(
    (
      await data.admin.from('problem_set_reports').insert({
        id: report,
        problem_set_id: set,
        reporter_user_id: data.id,
        reason: 'other',
      })
    ).error
  ).toBeNull();
  expect(
    await getFilteredProblemsCount(data.admin, data.id, subject, filter)
  ).toBe(1101);
  const direct = await getFilteredProblems(
    data.admin,
    data.id,
    subject,
    filter,
    data.id,
    { offset: 1000, limit: 51 }
  );
  expect(direct.map(row => row.id)).toEqual(ids.slice(1000, 1051));
  expect(direct.some(row => 'matching_tags' in row)).toBe(false);
  const oneTag = await getFilteredProblems(
    data.admin,
    data.id,
    subject,
    { ...filter, tag_ids: [tag] },
    data.id,
    { offset: 0, limit: 51 }
  );
  expect(
    oneTag.some(row => row.tags?.some(value => value.id === secondTag))
  ).toBe(true);
  await login(page, data);
  for (const offset of [0, 950, 1000, 1100]) {
    const response = await page.request.get(
      `/api/admin/reports/${report}?offset=${offset}`
    );
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.problems.map((row: { id: string }) => row.id)).toEqual(
      ids.slice(offset, offset + 50)
    );
    expect(body.hasMore).toBe(offset + 50 < ids.length);
  }
});

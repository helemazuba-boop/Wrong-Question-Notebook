import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './fixtures';

test('onboarding persists the chosen workflow and distinguishes dismissal from completion', async ({
  page,
  data,
}) => {
  const fields =
    'onboarding_scenario,onboarding_completed_at,onboarding_dismissed_at';
  const original = await data.admin
    .from('user_profiles')
    .select(fields)
    .eq('id', data.accounts.a.id)
    .single();
  expect(original.error).toBeNull();
  const reset = await data.admin
    .from('user_profiles')
    .update({
      onboarding_scenario: null,
      onboarding_completed_at: null,
      onboarding_dismissed_at: null,
    })
    .eq('id', data.accounts.a.id);
  expect(reset.error).toBeNull();
  try {
    await page.goto('/en/subjects');
    const chooser = page.getByRole('dialog', {
      name: 'Choose how you want to learn',
    });
    await chooser
      .getByRole('button', { name: 'Notes and reading', exact: true })
      .click();
    await expect(chooser).toBeHidden();
    const checklist = page.getByRole('complementary', {
      name: 'Getting Started',
    });
    await expect(checklist).toContainText('Getting Started (2/3)');
    await page.reload();
    await expect(chooser).toBeHidden();
    await expect(checklist).toContainText('Notes and reading');
    await expect(checklist).toContainText('Getting Started (2/3)');
    await checklist
      .getByRole('button', { name: 'Dismiss onboarding', exact: true })
      .click();
    await expect(checklist).toBeHidden();
    await page.reload();
    await expect(checklist).toHaveCount(0);
    const result = await data.admin
      .from('user_profiles')
      .select(fields)
      .eq('id', data.accounts.a.id)
      .single();
    expect(result.error).toBeNull();
    expect(result.data?.onboarding_scenario).toBe('notes');
    expect(result.data?.onboarding_completed_at).toBeNull();
    expect(result.data?.onboarding_dismissed_at).toBeTruthy();
  } finally {
    const restored = await data.admin
      .from('user_profiles')
      .update(original.data!)
      .eq('id', data.accounts.a.id);
    expect(restored.error).toBeNull();
  }
});

test('notebooks stay on the shelf and legacy list links return there', async ({
  page,
  data,
}) => {
  await page.setViewportSize({ width: 1664, height: 928 });
  for (const locale of ['en', 'zh-CN']) {
    const shelf = new RegExp(`/${locale}/subjects$`);
    const shelfLabel = locale === 'en' ? 'Notebook Shelf' : '笔记本架';
    await page.goto(`/${locale}/notebooks?page=2`);
    await expect(page).toHaveURL(shelf);
    await expect(
      page.getByRole('heading', { name: /notebook shelf|笔记本架/i })
    ).toBeVisible();
    const navigation = page.getByRole('navigation').first();
    await expect(navigation.locator('a[href$="/notebooks"]')).toHaveCount(0);
    await page.getByText(data.notebookTitle, { exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/${locale}/notebooks/${data.notebookId}$`)
    );
    await expect(
      navigation.getByRole('link', { name: shelfLabel, exact: true })
    ).toHaveAttribute('aria-current', 'page');
    const fresh = await page.context().newPage();
    try {
      for (const href of [
        page.url(),
        `${page.url()}?from=${encodeURIComponent('/notebooks?page=2')}`,
      ]) {
        await fresh.goto(href);
        await fresh
          .getByRole('button', {
            name: locale === 'en' ? 'Back to shelf' : '返回笔记本架',
            exact: true,
          })
          .click();
        await expect(fresh).toHaveURL(shelf);
        await expect(
          fresh.getByText(data.notebookTitle, { exact: true })
        ).toBeVisible();
      }
      await fresh.setViewportSize({ width: 390, height: 928 });
      await fresh
        .getByRole('button', {
          name: locale === 'en' ? 'Open navigation' : '打开应用导航',
          exact: true,
        })
        .click();
      const menu = fresh.getByRole('menu');
      await expect(
        menu.getByRole('link', {
          name: shelfLabel,
          exact: true,
        })
      ).toBeVisible();
      await expect(menu.locator('a[href$="/notebooks"]')).toHaveCount(0);
    } finally {
      await fresh.close();
    }
  }
});

test('a due todo reaches the reminder inbox and survives a new document', async ({
  page,
  data,
}) => {
  await page.goto('/en/todos');
  const title = `Audit reminder ${randomUUID()}`;
  const created = await page.evaluate(
    async ({ title, reminder_at, subject_id }) => {
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, reminder_at, subject_id }),
      });
      return { status: response.status, body: await response.json() };
    },
    {
      title,
      reminder_at: new Date(Date.now() - 120000).toISOString(),
      subject_id: data.subjectId,
    }
  );
  expect(created.status).toBe(201);
  try {
    expect((await page.request.get('/api/cron/todo-reminders')).status()).toBe(
      401
    );
    const tick = await page.request.get('/api/cron/todo-reminders', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(tick.status()).toBe(200);
    const fresh = await page.context().newPage();
    try {
      await fresh.goto('/en/todos');
      const inbox = fresh
        .getByRole('heading', { name: 'Todo reminders', exact: true })
        .locator('..');
      await expect(inbox).toContainText(title);
      await inbox
        .getByRole('button', { name: 'Mark read', exact: true })
        .click();
      await fresh.reload();
      await expect(inbox).toContainText(title);
      await expect(
        inbox.getByRole('button', { name: 'Mark read', exact: true })
      ).toHaveCount(0);
    } finally {
      await fresh.close();
    }
  } finally {
    await data.admin.from('todos').delete().eq('id', created.body.data.todo.id);
  }
});

test('report review revokes cached public access, preserves the owner copy and restores sharing', async ({
  page,
  data,
  browser,
}) => {
  const subject = randomUUID(),
    set = randomUUID(),
    problem = randomUUID(),
    title = `Audit ${randomUUID().slice(0, 8)}`;
  for (const [table, row] of [
    [
      'subjects',
      { id: subject, user_id: data.accounts.b.id, name: 'Audit moderation' },
    ],
    [
      'problem_sets',
      {
        id: set,
        user_id: data.accounts.b.id,
        subject_id: subject,
        name: title,
        sharing_level: 'public',
        is_listed: true,
      },
    ],
    [
      'problems',
      {
        id: problem,
        user_id: data.accounts.b.id,
        subject_id: subject,
        title: 'Preserved original',
        content: 'Audit private body',
        parts: [
          {
            index: 1,
            type: 'single_choice',
            content: 'Choose the review option',
            answer_config: {
              type: 'mcq',
              choices: [{ id: 'A', text: '<p>Visible review option</p>' }],
              correct_choice_id: 'A',
            },
          },
        ],
        status: 'needs_review',
      },
    ],
    [
      'problem_set_problems',
      { problem_set_id: set, problem_id: problem, user_id: data.accounts.b.id },
    ],
  ] as const) {
    const result = await data.admin.from(table).insert(row);
    expect(result.error).toBeNull();
  }
  const anonymous = await browser.newContext({
    baseURL: process.env.WQN_E2E_BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
  const owner = await browser.newContext({
    baseURL: process.env.WQN_E2E_BASE_URL,
    storageState: path.resolve('../.ci-local/auth/b.json'),
  });
  page.on('dialog', dialog => dialog.accept());
  try {
    const publicPage = await anonymous.newPage();
    await publicPage.goto(`/en/problem-sets/${set}`);
    await expect(
      publicPage.getByRole('heading', { name: title, exact: true })
    ).toBeVisible();
    await page.goto(`/en/problem-sets/${set}`);
    expect(
      await page.evaluate(
        async id =>
          (
            await fetch(`/api/problem-sets/${id}/report`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                reason: 'other',
                details: 'Audit fixture',
              }),
            })
          ).status,
        set
      )
    ).toBe(201);
    await data.admin
      .from('user_profiles')
      .update({ user_role: 'moderator' })
      .eq('id', data.accounts.a.id);
    await page.goto('/en/admin/reports');
    await page
      .getByRole('button', { name: 'Review reported questions', exact: true })
      .click();
    await expect(
      page.getByText('Visible review option', { exact: true })
    ).toBeVisible();
    await page.getByRole('textbox').fill('Sharing paused after review');
    await page
      .getByRole('button', { name: 'Pause sharing', exact: true })
      .click();
    await expect(
      page.getByText('No reports in this queue.', { exact: true })
    ).toBeVisible();
    const revoked = await anonymous.newPage();
    await revoked.goto(`/en/problem-sets/${set}`);
    await expect(
      revoked.getByRole('heading', { name: title, exact: true })
    ).toHaveCount(0);
    await expect(
      revoked.getByText('Audit private body', { exact: true })
    ).toHaveCount(0);
    const ownerPage = await owner.newPage();
    await ownerPage.goto(`/en/problem-sets/${set}`);
    await expect(
      ownerPage.getByRole('heading', { name: title, exact: true })
    ).toBeVisible();
    await expect(
      ownerPage.getByText('Sharing paused after review', { exact: true })
    ).toBeVisible();
    await page.goto('/en/reports');
    await expect(
      page.getByText('Sharing paused after review', { exact: true })
    ).toBeVisible();
    await page.goto('/en/admin/reports');
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('textbox').fill('Sharing restored after review');
    await page
      .getByRole('button', { name: 'Restore sharing', exact: true })
      .click();
    await expect(
      page.getByText('Report resolved.', { exact: true })
    ).toBeVisible();
    const restored = await anonymous.newPage();
    await restored.goto(`/en/problem-sets/${set}`);
    await expect(
      restored.getByRole('heading', { name: title, exact: true })
    ).toBeVisible();
  } finally {
    await anonymous.close();
    await owner.close();
    await data.admin
      .from('user_profiles')
      .update({ user_role: 'user' })
      .eq('id', data.accounts.a.id);
    await data.admin
      .from('problem_set_reports')
      .delete()
      .eq('problem_set_id', set);
    await data.admin.from('subjects').delete().eq('id', subject);
  }
});

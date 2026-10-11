import { test, expect } from './fixtures';

test('insert and edit inline and block formulas, then persist and render them after reload', async ({
  page,
  data,
}) => {
  await page.goto(`/en/subjects/${data.subjectId}/problems`);
  await page
    .getByRole('button', { name: 'Write manually', exact: true })
    .click();
  await page
    .getByPlaceholder('Short descriptive title for the problem')
    .fill('Browser math persistence');
  const editor = page.locator('.rich-text-editor-container').first();
  await editor.locator('[contenteditable=true]').fill('Solve the formulas: ');
  await editor.getByTitle('Add math formula', { exact: true }).click();
  await page.getByLabel('LaTeX Formula', { exact: true }).fill('x^2 + 1');
  await page.getByLabel('Block formula (displayed on its own line)').uncheck();
  await page
    .getByRole('button', { name: 'Insert Formula', exact: true })
    .click();
  await expect(
    editor.locator('[data-type="inline-math"] .katex').first()
  ).toBeVisible();
  await editor.locator('[contenteditable=true]').press('ControlOrMeta+End');
  await editor.getByTitle('Add math formula', { exact: true }).click();
  await page.getByLabel('LaTeX Formula', { exact: true }).fill('\\frac{1}{2}');
  await page.getByLabel('Block formula (displayed on its own line)').check();
  await page
    .getByRole('button', { name: 'Insert Formula', exact: true })
    .click();
  await expect(
    editor.locator('[data-type="block-math"] .katex').first()
  ).toBeVisible();
  await page.getByPlaceholder('Short expected answer').fill('42');
  const createdResponse = page.waitForResponse(
    response =>
      response.url().endsWith('/api/problems') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Add Problem', exact: true }).click();
  const created = await createdResponse;
  expect(created.ok()).toBeTruthy();
  const problemId = (await created.json()).data.id as string;
  const review = `/en/subjects/${data.subjectId}/problems/${problemId}/review`;
  const persisted = await page.context().newPage();
  try {
    await persisted.goto(review);
    await persisted.reload();
    await expect(
      persisted
        .locator('[data-type="inline-math"][data-latex="x^2 + 1"] .katex')
        .first()
    ).toBeVisible();
    await expect(
      persisted.locator('[data-type="block-math"] .katex').first()
    ).toBeVisible();

    await persisted.goto(`/en/subjects/${data.subjectId}/problems`);
    await persisted
      .getByRole('button', { name: 'Open menu', exact: true })
      .click();
    await persisted
      .getByRole('menuitem', { name: 'Edit problem', exact: true })
      .click();
    const edit = persisted.locator('.rich-text-editor-container').first();
    await edit.locator('[data-type="inline-math"]').click();
    await expect(
      persisted.getByLabel('LaTeX Formula', { exact: true })
    ).toHaveValue('x^2 + 1');
    await persisted
      .getByLabel('LaTeX Formula', { exact: true })
      .fill('x^2 + 2');
    await persisted
      .getByRole('button', { name: 'Update Formula', exact: true })
      .click();
    const savedResponse = persisted.waitForResponse(
      response =>
        response.url().endsWith(`/api/problems/${problemId}`) &&
        response.request().method() === 'PATCH'
    );
    await persisted
      .getByRole('button', { name: 'Edit Problem', exact: true })
      .click();
    expect((await savedResponse).ok()).toBeTruthy();
    await expect(
      persisted.getByPlaceholder('Short descriptive title for the problem')
    ).toBeHidden();
    await persisted.goto(review);
    await persisted.reload();
    await expect(
      persisted
        .locator('[data-type="inline-math"][data-latex="x^2 + 2"] .katex')
        .first()
    ).toBeVisible();
    await expect(
      persisted.locator('[data-type="inline-math"][data-latex="x^2 + 1"]')
    ).toHaveCount(0);
    await expect(
      persisted.locator('[data-type="block-math"] .katex').first()
    ).toBeVisible();
    await expect(persisted.locator('.katex-error')).toHaveCount(0);
  } finally {
    await persisted.close();
  }
  const { data: problem, error } = await data.admin
    .from('problems')
    .select('content,user_id')
    .eq('id', problemId)
    .single();
  expect(error).toBeNull();
  expect(problem?.user_id).toBe(data.accounts.a.id);
  expect(problem?.content).toContain('data-latex="x^2 + 2"');
  expect(problem?.content).toContain('data-type="block-math"');
  expect(problem?.content).not.toContain('data-latex="x^2 + 1"');
});

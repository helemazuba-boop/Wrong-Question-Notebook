import { test, expect, startStudy, observationCount } from './fixtures';

test('study answers advance cloud progress and survive refresh', async ({
  page,
  data,
}) => {
  const id = await startStudy(page, data);
  await page.getByRole('button', { name: '揭示释义', exact: true }).click();
  await page.getByRole('button', { name: /^认识\s*2$/ }).click();
  await expect.poll(() => observationCount(data, id)).toBe(1);
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  const { data: progress, error } = await data.admin
    .from('word_progress')
    .select('reviewed_count,known_count')
    .eq('user_id', data.accounts.a.id)
    .eq('reviewed_count', 1);
  expect(error).toBeNull();
  expect(progress).toContainEqual({ reviewed_count: 1, known_count: 1 });
});

test('a committed answer with a lost response is recovered exactly once', async ({
  page,
  data,
}) => {
  const id = await startStudy(page, data);
  let committedRequestId = '';
  let recovering = false;
  await page.route('**/api/words/study/observations', async route => {
    if (recovering) return route.continue();
    if (!committedRequestId) {
      committedRequestId = route.request().postDataJSON().request_id;
      const actual = await route.fetch();
      expect(actual.ok()).toBeTruthy();
    }
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: '揭示释义', exact: true }).click();
  await page.getByRole('button', { name: /^认识\s*2$/ }).click();
  await expect.poll(() => observationCount(data, id)).toBe(1);
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate(
      requestId =>
        Object.values(localStorage).some(value => value.includes(requestId)),
      committedRequestId
    )
  ).toBeTruthy();
  recovering = true;
  await page.reload();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        requestId =>
          Object.values(localStorage).some(value => value.includes(requestId)),
        committedRequestId
      )
    )
    .toBeFalsy();
  expect(await observationCount(data, id)).toBe(1);
  const { count, error } = await data.admin
    .from('word_review_events')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', id);
  expect(error).toBeNull();
  expect(count).toBe(1);
});

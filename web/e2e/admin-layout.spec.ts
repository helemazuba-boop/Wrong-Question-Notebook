import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { test, expect } from './fixtures';

test('admin layout uses available width, one page scrollbar and localized real storage counts', async ({
  page,
  data,
}, testInfo) => {
  const prefix = `user/${data.accounts.a.id}/admin-layout`;
  const files = [`${prefix}/sample.bin`, `${prefix}/empty.txt`];
  const storage = data.admin.storage.from('problem-uploads');
  const promote = await data.admin
    .from('user_profiles')
    .update({ user_role: 'super_admin' })
    .eq('id', data.accounts.a.id);
  expect(promote.error).toBeNull();
  try {
    for (const [name, content] of [
      [files[0], Buffer.alloc(Math.round(9.2 * 1024 * 1024), 1)],
      [files[1], Buffer.alloc(0)],
    ] as const) {
      const uploaded = await storage.upload(name, content, {
        contentType: 'application/octet-stream',
      });
      expect(uploaded.error).toBeNull();
    }

    const screenshots = path.resolve('../artifacts/admin-layout');
    await mkdir(screenshots, { recursive: true });
    for (const locale of ['zh-CN', 'en'] as const) {
      await page.setViewportSize({ width: 1664, height: 928 });
      await page.goto(`/${locale}/admin`);
      const heading = page.getByRole('heading', {
        name: locale === 'zh-CN' ? '仪表板' : 'Dashboard',
        exact: true,
      });
      await expect(heading).toBeVisible();
      await expect(page.getByRole('main')).toHaveCount(1);
      for (const width of [1664, 1536, 1440, 1280, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 928 });
        const screenshot = path.join(
          screenshots,
          `${locale}-${width}-${testInfo.project.name}.png`
        );
        await page.screenshot({ path: screenshot });
        if (width === 1664 || width === 390)
          await testInfo.attach(`${locale}-${width}`, {
            path: screenshot,
            contentType: 'image/png',
          });
        const bounds = await page.locator('.admin-page-bg').boundingBox();
        expect(bounds!.width).toBeGreaterThan(width - 48);

        const geometry = await page.locator('#main-content').evaluate(root => {
          const overflowing = [...root.querySelectorAll('*')].filter(node => {
            const element = node as HTMLElement;
            const style = getComputedStyle(element);
            return (
              ['auto', 'scroll'].includes(style.overflowY) &&
              element.scrollHeight > element.clientHeight + 1
            );
          });
          const cards = [...root.querySelectorAll('.admin-stat-card')];
          return {
            pageOverflow:
              document.documentElement.scrollWidth > window.innerWidth + 1,
            innerScrollers: overflowing.map(node => node.tagName),
            cardOverflow: cards.some(
              card => card.scrollWidth > card.clientWidth + 1
            ),
          };
        });
        expect(geometry, `${locale} at ${width}px`).toEqual({
          pageOverflow: false,
          innerScrollers: [],
          cardOverflow: false,
        });

        const actions = page
          .getByRole('heading', {
            name: locale === 'zh-CN' ? '快捷操作' : 'Quick Actions',
            exact: true,
          })
          .locator('..')
          .getByRole('link');
        for (const action of await actions.all()) {
          const rect = await action.boundingBox();
          expect(rect!.width).toBeGreaterThanOrEqual(247);
          const icons = action.locator('svg');
          expect(await icons.count()).toBe(2);
          expect(
            (await icons.nth(0).boundingBox())!.width
          ).toBeGreaterThanOrEqual(15);
          expect(
            (await icons.nth(1).boundingBox())!.width
          ).toBeGreaterThanOrEqual(15);
        }
      }

      if (locale === 'zh-CN') {
        await expect(page.locator('#main-content')).not.toContainText(
          'Manage Users'
        );
        await expect(page.locator('#main-content')).not.toContainText(
          'Admin Panel'
        );
        await expect(page.locator('#main-content')).not.toContainText(
          'No recent activity'
        );
      }
      const stats = await page.request.get('/api/admin/statistics');
      expect(stats.status()).toBe(200);
      const result = await stats.json();
      expect(result.storageStats.fileCount).toBe(2);
      expect(result.storageStats.totalBytes).toBe(
        Math.round(9.2 * 1024 * 1024)
      );
      const storageCard = page
        .locator('.admin-stat-card')
        .filter({ hasText: locale === 'zh-CN' ? '存储' : 'Storage' });
      await expect(storageCard).toContainText(
        locale === 'zh-CN' ? '2 个文件' : '2 files'
      );

      // The narrow-screen navigation is a modal, not a second page scroller.
      await page
        .getByRole('button', {
          name: locale === 'zh-CN' ? '管理导航' : 'Admin Navigation',
          exact: true,
        })
        .click();
      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();
      await drawer
        .getByRole('link', {
          name: locale === 'zh-CN' ? '仪表板' : 'Dashboard',
          exact: true,
        })
        .click();
      await expect(drawer).not.toBeVisible();

      await page
        .getByRole('button', {
          name: locale === 'zh-CN' ? '打开应用导航' : 'Open navigation',
          exact: true,
        })
        .click();
      await expect(
        page.getByRole('menu').getByRole('link', {
          name: locale === 'zh-CN' ? '笔记本架' : 'Notebook Shelf',
          exact: true,
        })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).not.toBeVisible();

      // Navigate in the same document to prove admin width does not carry over.
      await page.setViewportSize({ width: 1664, height: 928 });
      await page
        .getByRole('link', {
          name: locale === 'zh-CN' ? '返回应用' : 'Back to App',
          exact: true,
        })
        .click();
      await expect(page).not.toHaveURL(/\/admin/);
      const regularPage = await page.locator('#main-content').boundingBox();
      expect(regularPage!.width).toBeLessThanOrEqual(1152);
    }
  } finally {
    await storage.remove(files);
    await data.admin
      .from('user_profiles')
      .update({ user_role: 'user' })
      .eq('id', data.accounts.a.id);
  }
});

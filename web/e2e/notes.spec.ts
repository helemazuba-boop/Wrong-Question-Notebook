import sharp from 'sharp';
import { test, expect } from './fixtures';

test('create and edit a note, attach a real image and retain it after refresh', async ({
  page,
  data,
}) => {
  await page.goto(`/en/notebooks/${data.notebookId}`);
  await page
    .getByRole('button', { name: '新笔记', exact: true })
    .first()
    .click();
  const createDialog = page.getByRole('dialog', { name: '新笔记' });
  await createDialog
    .getByLabel('标题', { exact: true })
    .fill('Browser-created note');
  await createDialog
    .getByLabel('内容', { exact: true })
    .fill('Initial browser content');
  const createdResponse = page.waitForResponse(
    response =>
      response.url().endsWith(`/notebooks/${data.notebookId}/notes`) &&
      response.request().method() === 'POST'
  );
  await createDialog.getByRole('button', { name: '创建', exact: true }).click();
  const created = await createdResponse;
  expect(created.ok()).toBeTruthy();
  const noteId = (await created.json()).data.note.id as string;
  const editDialog = page.getByRole('dialog', { name: '编辑笔记' });
  await expect(editDialog).toBeVisible();
  await editDialog
    .getByLabel('标题', { exact: true })
    .fill('Persisted browser note');
  await editDialog
    .getByLabel('内容', { exact: true })
    .fill('Updated browser content');
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  const attachedResponse = page.waitForResponse(
    response =>
      response.url().endsWith(`/notes/${noteId}/images`) &&
      response.request().method() === 'POST'
  );
  await editDialog
    .getByLabel('笔记图片')
    .setInputFiles({ name: 'note.png', mimeType: 'image/png', buffer: png });
  const attached = await attachedResponse;
  expect(attached.ok()).toBeTruthy();
  const asset = (await attached.json()).data.note.assets[0];
  await expect(editDialog.getByAltText('墨水屏预览')).toBeVisible();
  await expect(
    editDialog.getByRole('button', { name: '添加图片' })
  ).toBeEnabled();
  const savedResponse = page.waitForResponse(
    response =>
      response.url().endsWith(`/notes/${noteId}`) &&
      response.request().method() === 'PATCH'
  );
  await editDialog.getByRole('button', { name: '保存', exact: true }).click();
  expect((await savedResponse).ok()).toBeTruthy();
  await page.reload();
  const card = page
    .getByTestId('note-card')
    .filter({ hasText: 'Persisted browser note' });
  await expect(card).toContainText('Updated browser content');
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  const preview = editDialog.getByAltText('墨水屏预览');
  await expect
    .poll(() =>
      preview.evaluate(image => (image as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0);
  const { data: note, error } = await data.admin
    .from('notebook_notes')
    .select('content,user_id,assets')
    .eq('id', noteId)
    .single();
  expect(error).toBeNull();
  expect(note?.content).toBe('Updated browser content');
  expect(note?.user_id).toBe(data.accounts.a.id);
  expect(note?.assets).toHaveLength(1);
  const { data: original, error: downloadError } = await data.admin.storage
    .from('problem-uploads')
    .download(asset.path);
  expect(downloadError).toBeNull();
  expect(Buffer.from(await original!.arrayBuffer()).equals(png)).toBeTruthy();
});

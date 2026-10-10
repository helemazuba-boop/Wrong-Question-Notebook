import * as XLSX from 'xlsx';
import { test, expect } from './fixtures';

for (const format of ['csv', 'xlsx']) {
  test(`preview and import ${format} into a real word deck`, async ({
    page,
    data,
  }) => {
    await page.goto(`/en/words/decks/${data.importDeckId}`);
    const rows = [
      ['单词', '释义'],
      ['durable', '持久的'],
      ['isolation', '隔离'],
    ];
    let buffer: Buffer;
    if (format === 'xlsx') {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet(rows),
        'Words'
      );
      buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    } else buffer = Buffer.from(rows.map(row => row.join(',')).join('\n'));
    await page
      .getByLabel('Excel / CSV / TSV / JSON 文件', { exact: true })
      .setInputFiles({
        name: `words.${format}`,
        mimeType:
          format === 'csv'
            ? 'text/csv'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer,
      });
    await expect(page.getByText(/当前识别/)).toContainText(/2\s*条可导入/);
    const response = page.waitForResponse(
      response =>
        response.url().endsWith(`/decks/${data.importDeckId}/import`) &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: '导入到词库', exact: true }).click();
    expect((await response).ok()).toBeTruthy();
    await expect(page.getByText('上次成功导入 2 条。')).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('cell', { name: 'durable', exact: true })
    ).toBeVisible();
    const { data: entries, error } = await data.admin
      .from('word_entries')
      .select('word,meaning')
      .eq('deck_id', data.importDeckId)
      .order('word');
    expect(error).toBeNull();
    expect(entries).toEqual([
      { word: 'durable', meaning: '持久的' },
      { word: 'isolation', meaning: '隔离' },
    ]);
  });
}

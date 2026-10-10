import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { test, expect } from './fixtures';

test('a second ordinary user cannot read or mutate private notebook data', async ({
  context,
  browser,
  data,
  baseURL,
}) => {
  const endpoint = `/api/notebooks/${data.notebookId}/notes/${data.noteId}`;
  const headers = { Origin: baseURL! };
  const owner = await context.request.patch(endpoint, {
    headers,
    data: { expected_revision: 1, content: 'Owner update' },
  });
  expect(owner.ok()).toBeTruthy();
  const revision = (await owner.json()).data.note.revision;
  const other = await browser.newContext({
    baseURL,
    storageState: path.resolve('../.ci-local/auth/b.json'),
  });
  try {
    const page = await other.newPage();
    await page.goto(`/en/notebooks/${data.notebookId}`);
    await expect(
      page.getByText(data.notebookTitle, { exact: true })
    ).toHaveCount(0);
    const read = await other.request.get(endpoint);
    expect([403, 404]).toContain(read.status());
    const write = await other.request.patch(endpoint, {
      headers,
      data: { expected_revision: revision, content: 'Foreign overwrite' },
    });
    expect([403, 404]).toContain(write.status());
    const ordinary = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
    const { error: loginError } = await ordinary.auth.signInWithPassword(
      data.accounts.b
    );
    expect(loginError).toBeNull();
    const { data: visible, error: rlsError } = await ordinary
      .from('notebooks')
      .select('id')
      .eq('id', data.notebookId);
    expect(rlsError).toBeNull();
    expect(visible).toEqual([]);
    const { data: note, error } = await data.admin
      .from('notebook_notes')
      .select('content')
      .eq('id', data.noteId)
      .single();
    expect(error).toBeNull();
    expect(note?.content).toBe('Owner update');
  } finally {
    await other.close();
  }
});

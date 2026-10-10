import { test as base, expect, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Account = { id: string; email: string; password: string };
type Data = {
  admin: SupabaseClient;
  accounts: { a: Account; b: Account };
  subjectId: string;
  notebookId: string;
  notebookTitle: string;
  noteId: string;
  studyDeckId: string;
  importDeckId: string;
  sessionIds: string[];
};

async function removeObjects(admin: SupabaseClient, prefix: string) {
  const { data, error } = await admin.storage
    .from('problem-uploads')
    .list(prefix, { limit: 100 });
  if (error) throw error;
  const files: string[] = [];
  for (const item of data || []) {
    if (item.id) files.push(`${prefix}/${item.name}`);
    else await removeObjects(admin, `${prefix}/${item.name}`);
  }
  if (files.length) {
    const { error: removeError } = await admin.storage
      .from('problem-uploads')
      .remove(files);
    if (removeError) throw removeError;
  }
}

export const test = base.extend<{ data: Data }>({
  data: async ({ page: _page }, provide) => {
    const accounts = JSON.parse(
      readFileSync(path.resolve('../.ci-local/auth/accounts.json'), 'utf8')
    ) as Data['accounts'];
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
    const data: Data = {
      admin,
      accounts,
      subjectId: randomUUID(),
      notebookId: randomUUID(),
      notebookTitle: `E2E private notebook ${randomUUID()}`,
      noteId: randomUUID(),
      studyDeckId: randomUUID(),
      importDeckId: randomUUID(),
      sessionIds: [],
    };
    const seeds: Array<[string, Record<string, unknown>[]]> = [
      [
        'subjects',
        [
          {
            id: data.subjectId,
            user_id: accounts.a.id,
            name: `E2E ${data.subjectId}`,
          },
        ],
      ],
      [
        'notebooks',
        [
          {
            id: data.notebookId,
            user_id: accounts.a.id,
            subject_id: data.subjectId,
            title: data.notebookTitle,
          },
        ],
      ],
      [
        'notebook_notes',
        [
          {
            id: data.noteId,
            user_id: accounts.a.id,
            notebook_id: data.notebookId,
            title: 'Seed private note',
            content: 'Owner-only original content',
          },
        ],
      ],
      [
        'word_decks',
        [data.studyDeckId, data.importDeckId].map((id, index) => ({
          id,
          user_id: accounts.a.id,
          subject_id: data.subjectId,
          title: `E2E ${index === 0 ? 'study' : 'import'} ${id}`,
          source: 'user',
        })),
      ],
      [
        'word_entries',
        ['apple', 'banana'].map((word, index) => ({
          deck_id: data.studyDeckId,
          word,
          normalized_word: word,
          meaning: index === 0 ? '苹果' : '香蕉',
          sort_index: index,
        })),
      ],
    ];
    for (const [table, rows] of seeds) {
      const { error } = await admin.from(table).insert(rows);
      if (error) throw new Error(`E2E fixture ${table}: ${error.message}`);
    }
    try {
      await provide(data);
    } finally {
      const { data: notes, error } = await admin
        .from('notebook_notes')
        .select('id')
        .eq('notebook_id', data.notebookId);
      if (error) throw error;
      for (const note of notes || [])
        await removeObjects(admin, `user/${accounts.a.id}/notes/${note.id}`);
      for (const [table, column, ids] of [
        ['study_sessions', 'id', data.sessionIds],
        ['word_decks', 'id', [data.studyDeckId, data.importDeckId]],
        ['subjects', 'id', [data.subjectId]],
      ] as const) {
        if (!ids.length) continue;
        const { error: deleteError } = await admin
          .from(table)
          .delete()
          .in(column, ids);
        if (deleteError) throw deleteError;
      }
    }
  },
});
export { expect };

export async function startStudy(page: Page, data: Data) {
  await page.goto(`/en/words/study/new?deck=${data.studyDeckId}`);
  await page.getByLabel('本次数量', { exact: true }).click();
  await page.getByRole('option', { name: /^10\s*词$/ }).click();
  const response = page.waitForResponse(
    response =>
      response.url().endsWith('/api/words/study/sessions') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const body = await result.json();
  const id = body.data.session_id as string;
  data.sessionIds.push(id);
  await expect(page).toHaveURL(new RegExp(`/words/study/${id}$`));
  return id;
}

export async function observationCount(data: Data, sessionId: string) {
  const { count, error } = await data.admin
    .from('study_observations')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId);
  if (error) throw error;
  return count;
}

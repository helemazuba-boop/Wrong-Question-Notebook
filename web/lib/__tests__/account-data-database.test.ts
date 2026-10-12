import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract } from 'tar';
vi.mock('server-only', () => ({}));
import { processAccountDataJobs } from '@/lib/account-data';
const url = process.env.WQN_ACCOUNT_TEST_SUPABASE_URL,
  key = process.env.WQN_ACCOUNT_TEST_SERVICE_ROLE_KEY;
describe.skipIf(!url || !key)(
  'local database and storage account lifecycle',
  () => {
    const client = createClient(url ?? 'http://127.0.0.1', key ?? 'unused', {
      auth: { persistSession: false },
    });
    const users: string[] = [],
      subjectA = randomUUID(),
      subjectB = randomUUID(),
      notebook = randomUUID(),
      deck = randomUUID(),
      entry = randomUUID(),
      copiedProblem = randomUUID();
    let imagePath = '';
    beforeAll(async () => {
      if (!['localhost', '127.0.0.1'].includes(new URL(url!).hostname))
        throw new Error('Account tests require an isolated localhost Supabase');
      for (let i = 0; i < 2; i++) {
        const { data, error } = await client.auth.admin.createUser({
          email: `account-${randomUUID()}@example.invalid`,
          password: randomUUID(),
          email_confirm: true,
        });
        if (error) throw error;
        users.push(data.user.id);
      }
      async function insert(table: string, rows: unknown) {
        const { error } = await client.from(table).insert(rows);
        if (error) throw error;
      }
      await insert('subjects', [
        { id: subjectA, user_id: users[0], name: 'Export' },
        { id: subjectB, user_id: users[1], name: 'Copy' },
      ]);
      await insert('notebooks', {
        id: notebook,
        user_id: users[0],
        subject_id: subjectA,
        title: 'Notes',
      });
      await insert('notebook_notes', {
        user_id: users[0],
        notebook_id: notebook,
        title: 'Note',
        content: 'Content',
        sort_index: 0,
      });
      await insert('word_decks', {
        id: deck,
        user_id: users[0],
        title: 'Words',
        source: 'user',
        language: 'en',
        target_language: 'zh-CN',
      });
      await insert('word_entries', {
        id: entry,
        deck_id: deck,
        word: 'test',
        normalized_word: 'test',
        meaning: 'test',
      });
      await insert(
        'todos',
        Array.from({ length: 1001 }, (_, i) => ({
          user_id: users[0],
          title: `Export task ${i}`,
        }))
      );
      imagePath = `user/${users[0]}/problems/original/image.txt`;
      const uploaded = await client.storage
        .from('problem-uploads')
        .upload(imagePath, 'original image', { contentType: 'image/png' });
      if (uploaded.error) throw uploaded.error;
      await insert('problems', {
        id: copiedProblem,
        user_id: users[1],
        subject_id: subjectB,
        title: 'Copied question',
        status: 'needs_review',
        parts: [{ index: 1, type: 'short_answer' }],
        assets: [{ path: imagePath }],
      });
    }, 30000);
    afterAll(async () => {
      for (const id of users) {
        const { data } = await client.rpc('account_storage_objects', {
          p_user_id: id,
        });
        for (const object of data ?? [])
          await client.storage.from(object.bucket).remove([object.path]);
        await client.auth.admin.deleteUser(id);
        await client.from('account_data_jobs').delete().eq('user_id', id);
      }
    });
    it('exports every row plus owned binary files, then deletes all modules while preserving a foreign copy', async () => {
      const enqueue = await client.rpc('enqueue_account_data_job', {
        p_user_id: users[0],
        p_actor_id: users[0],
        p_kind: 'export',
      });
      if (enqueue.error) throw enqueue.error;
      const processed = await processAccountDataJobs(client);
      if (processed.status !== 'completed') {
        const failed = await client
          .from('account_data_jobs')
          .select('last_error')
          .eq('user_id', users[0])
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        throw new Error(failed.data?.last_error ?? 'Account test job failed');
      }
      const { data: job } = await client
        .from('account_data_jobs')
        .select('*')
        .eq('id', enqueue.data)
        .single();
      const archive = await client.storage
        .from('account-exports')
        .download(job!.archive_path);
      expect(archive.error).toBeNull();
      const folder = await mkdtemp(join(tmpdir(), 'wqn-export-test-'));
      try {
        const file = join(folder, 'export.tar.gz');
        await writeFile(file, Buffer.from(await archive.data!.arrayBuffer()));
        await extract({ file, cwd: folder });
        const exported = JSON.parse(
          await readFile(join(folder, 'data.json'), 'utf8')
        );
        expect(exported.tables.todos).toHaveLength(1001);
        expect(exported.tables.notebook_notes).toHaveLength(1);
        expect(exported.tables.word_entries).toHaveLength(1);
        expect(
          await readFile(
            join(folder, 'assets/problem-uploads', imagePath),
            'utf8'
          )
        ).toBe('original image');
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
      const deletion = await client.rpc('enqueue_account_data_job', {
        p_user_id: users[0],
        p_actor_id: users[0],
        p_kind: 'delete',
      });
      if (deletion.error) throw deletion.error;
      const deletedResult = await processAccountDataJobs(client);
      if (deletedResult.status !== 'completed') {
        const failed = await client
          .from('account_data_jobs')
          .select('last_error')
          .eq('user_id', users[0])
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        throw new Error(failed.data?.last_error ?? 'Account test job failed');
      }
      expect(
        (await client.auth.admin.getUserById(users[0])).error
      ).not.toBeNull();
      for (const table of ['todos', 'notebook_notes', 'word_decks'])
        expect(
          (await client.from(table).select('*').eq('user_id', users[0])).data
        ).toHaveLength(0);
      const copy = await client
        .from('problems')
        .select('assets')
        .eq('id', copiedProblem)
        .single();
      const retained = copy.data!.assets[0].path;
      expect(retained).toContain(`user/${users[1]}/retained/`);
      expect(
        await (
          await client.storage.from('problem-uploads').download(retained)
        ).data!.text()
      ).toBe('original image');
      expect(
        (await client.rpc('account_storage_objects', { p_user_id: users[0] }))
          .data
      ).toHaveLength(0);
    }, 60000);
  }
);

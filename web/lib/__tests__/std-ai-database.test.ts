import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAiToolExecutor } from '@/app/api/esp32/ai/transcribe-chat/v2-tools';
import { createVoiceInteractionGateway } from '@/lib/ai-tools/voice-interaction';

const container = process.env.WQN_VOICE_TEST_PG_CONTAINER;
const database = process.env.WQN_VOICE_TEST_PG_DATABASE;
function literal(value: unknown) {
  return `'${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
}
function sql(statement: string): any {
  if (!container || !database?.startsWith('wqn_voice_test_'))
    throw new Error('A disposable local wqn_voice_test_* database is required');
  const text = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'sh',
      '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U supabase_admin -d "$1"',
      'std-ai-test',
      database,
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
  return text ? JSON.parse(text) : null;
}
const supabase: any = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    try {
      return {
        data: sql(
          `select public.${name}(${Object.entries(args)
            .map(([k, v]) => `${k}=>${v == null ? 'null' : literal(v)}`)
            .join(',')});`
        ),
        error: null,
      };
    } catch (error) {
      return {
        data: null,
        error: {
          message:
            /ERROR:\s+([^\n]+)/.exec(String((error as any).stderr))?.[1] ??
            'unavailable',
        },
      };
    }
  },
  from: (table: string) => {
    if (!['mcp_v2_operations', 'esp32_ai_interactions'].includes(table))
      throw new Error(table);
    const where: string[] = [];
    let update = false;
    const query: any = {
      select: () => query,
      eq: (k: string, v: unknown) => {
        where.push(`${k}=${literal(v)}`);
        return query;
      },
      maybeSingle: async () => ({
        data: sql(
          `select to_jsonb(o) from public.${table} o where ${where.join(' and ')};`
        ),
        error: null,
      }),
      update: () => {
        update = true;
        return query;
      },
      then: (resolve: (value: unknown) => void) => {
        if (update)
          sql(
            `with changed as (update public.${table} set state='cancelled' where ${where.join(' and ')} returning id) select to_jsonb(count(*)) from changed;`
          );
        resolve({ data: null, error: null });
      },
    };
    return query;
  },
};
const user = randomUUID(),
  device = randomUUID(),
  notebook = randomUUID(),
  subject = randomUUID();
const time = { now: '2026-10-26T15:30:00Z', timezone: 'Asia/Shanghai' };
describe.skipIf(!container || !database)(
  'STD decisions → actual PostgreSQL writes',
  () => {
    beforeAll(() =>
      sql(`
    insert into auth.users(id,email) values(${literal(user)},${literal(user + '@std.test')});
    insert into public.esp32_devices(id,user_id,mac_address,access_token_hash)
      values(${literal(device)},${literal(user)},${literal('02:' + device.replaceAll('-', '').slice(0, 10).match(/../g)!.join(':'))},${literal(createHash('sha256').update(device).digest('hex'))});
    insert into public.subjects(id,user_id,name) values(${literal(subject)},${literal(user)},'STD');
    insert into public.notebooks(id,user_id,subject_id,title) values(${literal(notebook)},${literal(user)},${literal(subject)},'STD Notes');
    insert into public.notebook_ai_access(user_id,notebook_id,can_create) values(${literal(user)},${literal(notebook)},true);
  `)
    );
    afterAll(() =>
      sql(`delete from public.notebook_notes where user_id=${literal(user)};
    delete from public.notebooks where user_id=${literal(user)};delete from auth.users where id=${literal(user)};`)
    );
    function harness(requestId = randomUUID(), now = time.now) {
      let id = '';
      const ctx = {
        userId: user,
        deviceId: device,
        requestId,
        timeContext: { ...time, now },
        origin: '',
        supabase,
      };
      const interaction = createVoiceInteractionGateway(
        ctx,
        requestId,
        {
          emit: (event: string, data: any) => {
            if (event === 'interaction.request') id = data.interaction_id;
          },
        } as any,
        () => 10000
      );
      return {
        execute: buildAiToolExecutor({
          ...ctx,
          requireConfirmation: true,
          interaction,
        }),
        id: () => id,
        requestId,
      };
    }
    async function waitId(h: ReturnType<typeof harness>) {
      for (let i = 0; i < 200 && !h.id(); i++)
        await new Promise(r => setTimeout(r, 5));
      expect(h.id()).not.toBe('');
      return h.id();
    }
    function reply(id: string, answer: string) {
      return supabase.rpc('reply_esp32_ai_interaction_v1', {
        p_user_id: user,
        p_device_id: device,
        p_id: id,
        p_answer: answer,
      });
    }
    it('creates nothing before approval, then commits once and replays the same receipt', async () => {
      const h = harness(),
        args = JSON.stringify({
          title: 'STD approval fixture',
          due: { date: 'tomorrow' },
        });
      const pending = h.execute('create_todo', args, { callId: 'todo' });
      const id = await waitId(h);
      expect(
        sql(
          `select count(*)::int from public.todos where user_id=${literal(user)};`
        )
      ).toBe(0);
      expect((await reply(id, 'approve')).error).toBeNull();
      expect((await reply(id, 'approve')).error).toBeNull();
      expect((await reply(id, 'reject')).error).not.toBeNull();
      const first = await pending;
      expect(first.ok).toBe(true);
      const replay = harness(h.requestId, '2026-10-28T00:00:00Z');
      const again = await replay.execute('create_todo', args, {
        callId: 'todo',
      });
      expect(again.ok).toBe(true);
      expect((again.data as any).todo.id).toBe((first.data as any).todo.id);
      expect(
        sql(
          `select count(*)::int from public.todos where user_id=${literal(user)};`
        )
      ).toBe(1);
    });
    it('rejects a Note without creating either a business row or a write operation', async () => {
      const h = harness();
      const pending = h.execute(
        'create_notebook_note',
        JSON.stringify({
          notebook_id: notebook,
          title: 'rejected',
          content: 'must not exist',
        }),
        { callId: 'note' }
      );
      const id = await waitId(h);
      await reply(id, 'reject');
      expect((await pending).error?.code).toBe('user_cancelled');
      expect(
        sql(
          `select count(*)::int from public.notebook_notes where user_id=${literal(user)};`
        )
      ).toBe(0);
    });
    it('rejects another device, unknown options and expired decisions', async () => {
      const h = harness();
      const pending = h.execute(
        'ask_question',
        JSON.stringify({
          question: '请选择',
          options: [{ label: '一', value: 'one' }],
        }),
        { callId: 'question' }
      );
      const id = await waitId(h);
      const foreign = await supabase.rpc('reply_esp32_ai_interaction_v1', {
        p_user_id: user,
        p_device_id: randomUUID(),
        p_id: id,
        p_answer: 'one',
      });
      expect(foreign.error).not.toBeNull();
      expect((await reply(id, 'invented')).error).not.toBeNull();
      sql(
        `update public.esp32_ai_interactions set expires_at=now()-interval '1 second' where id=${literal(id)};`
      );
      expect((await reply(id, 'one')).error).not.toBeNull();
      expect((await pending).ok).toBe(false);
    });
    it('custom answer settles the question without executing a write', async () => {
      const h = harness();
      const pending = h.execute(
        'ask_question',
        JSON.stringify({
          question: '请选择',
          options: [{ label: '一', value: 'one' }],
        }),
        { callId: 'custom' }
      );
      await reply(await waitId(h), '__custom__');
      expect((await pending).error?.code).toBe('user_cancelled');
    });
    it('rechecks notebook permissions after the user has approved', async () => {
      const h = harness();
      const pending = h.execute(
        'create_notebook_note',
        JSON.stringify({
          notebook_id: notebook,
          title: 'revoked',
          content: 'must not exist',
        }),
        { callId: 'note' }
      );
      const id = await waitId(h);
      sql(
        `update public.notebook_ai_access set can_create=false where notebook_id=${literal(notebook)};`
      );
      await reply(id, 'approve');
      expect((await pending).error?.code).toBe('notebook_permission_denied');
      expect(
        sql(
          `select count(*)::int from public.notebook_notes where user_id=${literal(user)};`
        )
      ).toBe(0);
    });
    it('grants interaction access only to the service role', () => {
      expect(
        sql(
          "select to_jsonb(has_function_privilege('authenticated','public.reply_esp32_ai_interaction_v1(uuid,uuid,uuid,text)','EXECUTE')); "
        )
      ).toBe(false);
      expect(
        sql(
          "select to_jsonb(has_table_privilege('authenticated','public.esp32_ai_interactions','SELECT,INSERT,UPDATE')); "
        )
      ).toBe(false);
      expect(
        sql(
          "select to_jsonb(has_function_privilege('service_role','public.reply_esp32_ai_interaction_v1(uuid,uuid,uuid,text)','EXECUTE')); "
        )
      ).toBe(true);
    });
  }
);

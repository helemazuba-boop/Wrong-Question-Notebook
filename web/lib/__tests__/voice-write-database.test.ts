import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAiToolExecutor } from '@/app/api/esp32/ai/transcribe-chat/v2-tools';

// Opt in against a disposable local database with the WQN migrations applied.
// No service key, network database URL, or production database is accepted.
const container = process.env.WQN_VOICE_TEST_PG_CONTAINER;
const database = process.env.WQN_VOICE_TEST_PG_DATABASE;
const enabled = Boolean(container && database);
function literal(value: unknown) {
  return `'${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
}
function sql(statement: string): any {
  if (!container || !database?.startsWith('wqn_voice_test_'))
    throw new Error('Use a disposable wqn_voice_test_* database');
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'sh',
      '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U supabase_admin -d "$1"',
      'voice-test',
      database,
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
  return output ? JSON.parse(output) : null;
}
const user = randomUUID(),
  device = randomUUID(),
  subject = randomUUID(),
  notebook = randomUUID(),
  conversation = randomUUID();
const supabase = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    try {
      return {
        data: sql(
          `select public.${name}(${Object.entries(args)
            .map(
              ([key, value]) =>
                `${key} => ${value == null ? 'null' : literal(value)}`
            )
            .join(',')});`
        ),
        error: null,
      };
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr);
      return {
        data: null,
        error: {
          message:
            /ERROR:\s+([^\n]+)/.exec(stderr)?.[1] ?? 'database_unavailable',
        },
      };
    }
  },
  from: (table: string) => {
    if (table !== 'mcp_v2_operations') throw new Error(`Unexpected ${table}`);
    const conditions: string[] = [];
    const query = {
      select: () => query,
      eq: (key: string, value: string) => {
        conditions.push(`${key}=${literal(value)}`);
        return query;
      },
      maybeSingle: async () => ({
        data: sql(
          `select to_jsonb(o) from public.mcp_v2_operations o where ${conditions.join(' and ')};`
        ),
        error: null,
      }),
    };
    return query;
  },
};
const time = { now: '2026-10-21T00:00:00Z', timezone: 'Asia/Shanghai' };
const execute = (client = supabase) =>
  buildAiToolExecutor({
    userId: user,
    deviceId: device,
    conversationId: conversation,
    requestId: 'database_voice_turn',
    timeContext: time,
    supabase: client as any,
  });
describe.skipIf(!enabled)('voice executor → real PostgreSQL', () => {
  beforeAll(() => {
    sql(`
      insert into auth.users(id,email) values(${literal(user)},${literal(`${user}@voice.test`)});
      insert into public.esp32_devices(id,user_id,mac_address,access_token_hash)
        values(${literal(device)},${literal(user)},${literal(`02:${device.replaceAll('-', '').slice(0, 10).match(/../g)!.join(':')}`)},${literal(createHash('sha256').update(device).digest('hex'))});
      insert into public.subjects(id,user_id,name) values(${literal(subject)},${literal(user)},'Voice');
      insert into public.notebooks(id,user_id,subject_id,title)
        values(${literal(notebook)},${literal(user)},${literal(subject)},'Voice Notes');
      insert into public.notebook_ai_access(user_id,notebook_id,can_create)
        values(${literal(user)},${literal(notebook)},true);
    `);
  });
  afterAll(() => {
    sql(`
      delete from public.notebook_notes where user_id=${literal(user)};
      delete from public.notebooks where user_id=${literal(user)};
      delete from auth.users where id=${literal(user)};
    `);
  });
  it('creates a Note using actual prepared fields, then replays the same receipt', async () => {
    const args = JSON.stringify({
      notebook_id: notebook,
      title: '语音笔记',
      content: '正文\n保留换行',
    });
    const first = await execute()('create_notebook_note', args, {
      callId: 'note-call',
    });
    expect(first).toMatchObject({ ok: true });
    const note = (first.data as any).note;
    expect(note).toMatchObject({
      source: 'ai',
      content_format: 'plain_text_v1',
      metadata: { source_conversation_id: conversation },
      content: '正文\n保留换行',
    });
    expect(
      await execute()('create_notebook_note', args, { callId: 'note-call' })
    ).toEqual(first);
    expect(
      sql(
        `select count(*)::int from public.notebook_notes where user_id=${literal(user)};`
      )
    ).toBe(1);
    expect(
      await execute()(
        'create_notebook_note',
        JSON.stringify({ ...JSON.parse(args), content: 'changed' }),
        { callId: 'note-call' }
      )
    ).toMatchObject({ ok: false, error: { code: 'request_id_reused' } });
  });
  it('creates a Todo with a relative due date and updates its status', async () => {
    const first = await execute()(
      'create_todo',
      JSON.stringify({ title: '复习', due: { date: 'tomorrow' } }),
      { callId: 'todo-call' }
    );
    expect(first.ok).toBe(true);
    const todo = (first.data as any).todo;
    expect(Date.parse(todo.due_at)).toBe(Date.parse('2026-10-22T15:59:59Z'));
    expect(todo.reminder_at).toBeNull();
    const updated = await execute()(
      'update_todo_status',
      JSON.stringify({ todo_id: todo.id, status: 'completed' }),
      { callId: 'status-call' }
    );
    expect(updated).toMatchObject({
      ok: true,
      data: { todo: { status: 'completed' } },
    });
  });
  it('recovers an actually committed Note after its response is lost', async () => {
    const client = {
      ...supabase,
      rpc: async (name: string, args: Record<string, unknown>) => {
        const result = await supabase.rpc(name, args);
        if (name === 'commit_mcp_voice_operation_v1')
          throw new Error('response lost');
        return result;
      },
    };
    expect(
      await execute(client)(
        'create_notebook_note',
        JSON.stringify({
          notebook_id: notebook,
          title: 'lost response',
          content: 'saved once',
        }),
        { callId: 'lost-call' }
      )
    ).toMatchObject({ ok: true });
    expect(
      sql(
        `select count(*)::int from public.notebook_notes where user_id=${literal(user)} and title='lost response';`
      )
    ).toBe(1);
  });
  it('does not return a committed Note receipt after create permission is revoked', async () => {
    sql(
      `update public.notebook_ai_access set can_create=false where notebook_id=${literal(notebook)};`
    );
    expect(
      await execute()(
        'create_notebook_note',
        JSON.stringify({
          notebook_id: notebook,
          title: '语音笔记',
          content: '正文\n保留换行',
        }),
        { callId: 'note-call' }
      )
    ).toMatchObject({
      ok: false,
      error: { code: 'notebook_permission_denied' },
    });
  });
});

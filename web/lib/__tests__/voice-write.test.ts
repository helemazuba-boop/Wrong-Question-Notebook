import { describe, it, expect, vi } from 'vitest';
import { executeVoiceWrite } from '@/lib/ai-tools/voice-write';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function harness(lost = false, unavailable = false) {
  let op: any = null,
    business = 0;
  const rpc = vi.fn(async (name: string, args: any) => {
    if (name === 'begin_mcp_voice_operation_v1') {
      if (op) {
        if (op.fingerprint !== args.p_fingerprint)
          return { data: null, error: { message: 'request_id_reused' } };
        return {
          data: {
            ...op,
            claimed: op.state !== 'committed' && op.state !== 'failed',
          },
          error: null,
        };
      }
      op = {
        id: user,
        user_id: user,
        tool_name: args.p_tool_name,
        arguments: args.p_arguments,
        fingerprint: args.p_fingerprint,
        state: 'preparing',
        lease_token: device,
        prepared: null,
        receipt: null,
      };
      return { data: { ...op, claimed: true }, error: null };
    }
    if (name === 'prepare_mcp_operation_v2') {
      op = { ...op, state: 'prepared', prepared: args.p_prepared };
      return { data: op, error: null };
    }
    if (name === 'commit_mcp_voice_operation_v1') {
      if (op.state !== 'committed') {
        business++;
        op = {
          ...op,
          state: 'committed',
          receipt: {
            row: { ...op.prepared.row, created_at: 'now', status: 'pending' },
          },
        };
      }
      return lost &&
        business === 1 &&
        rpc.mock.calls.filter(c => c[0] === name).length === 1
        ? { data: null, error: { message: 'response lost' } }
        : { data: op, error: null };
    }
    if (name === 'fail_mcp_operation_v2') {
      op.state = 'failed';
      op.error = {
        code: args.p_code,
        message: '原写入尚未提交。',
        retryable: args.p_retryable,
      };
      return { data: null, error: null };
    }
    throw new Error(name);
  });
  const q: any = {};
  q.select = q.eq = () => q;
  q.maybeSingle = async () =>
    unavailable
      ? { data: null, error: { message: 'status down' } }
      : { data: op, error: null };
  const ctx = {
    userId: user,
    deviceId: device,
    supabase: { rpc, from: () => q },
  } as any;
  return { ctx, rpc, op: () => op, business: () => business };
}
const time = { now: '2026-10-14T16:30:00Z', timezone: 'Asia/Shanghai' };
describe('voice write receipt recovery', () => {
  it('recovers a lost commit response and replays the original local date next day', async () => {
    const h = harness(true),
      args = { title: '复习', due: { date: 'tomorrow' } };
    const first = await executeVoiceWrite(
      h.ctx,
      'create_todo',
      args,
      'voice_request_001',
      time
    );
    expect(first.todo.due_at).toBe('2026-10-16T15:59:59.000Z');
    const again = await executeVoiceWrite(
      h.ctx,
      'create_todo',
      args,
      'voice_request_001',
      { ...time, now: '2026-10-20T00:00:00Z' }
    );
    expect(again.todo.due_at).toBe(first.todo.due_at);
    expect(h.business()).toBe(1);
    expect(h.rpc.mock.calls.some(c => c[0] === 'fail_mcp_operation_v2')).toBe(
      false
    );
  });
  it('rejects changed content under a used voice operation ID', async () => {
    const h = harness();
    await executeVoiceWrite(
      h.ctx,
      'create_todo',
      { title: 'a' },
      'voice_request_001',
      time
    );
    await expect(
      executeVoiceWrite(
        h.ctx,
        'create_todo',
        { title: 'b' },
        'voice_request_001',
        time
      )
    ).rejects.toMatchObject({ code: 'request_id_reused' });
    expect(h.business()).toBe(1);
  });
  it('reports a lost response as unknown when the durable receipt cannot be queried', async () => {
    const h = harness(true, true);
    await expect(
      executeVoiceWrite(
        h.ctx,
        'create_todo',
        { title: 'a' },
        'voice_request_001',
        time
      )
    ).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(h.business()).toBe(1);
    expect(h.rpc.mock.calls.some(c => c[0] === 'fail_mcp_operation_v2')).toBe(
      false
    );
  });
  it('does not create a Todo before an ambiguous reminder has been clarified', async () => {
    const h = harness();
    await expect(
      executeVoiceWrite(
        h.ctx,
        'create_todo',
        { title: 'a', reminder: { date: 'tomorrow' } },
        'voice_request_001',
        time
      )
    ).rejects.toMatchObject({ code: 'reminder_time_required' });
    expect(h.business()).toBe(0);
    await expect(
      executeVoiceWrite(
        h.ctx,
        'create_todo',
        { title: 'a', reminder: { date: 'tomorrow' } },
        'voice_request_001',
        time
      )
    ).rejects.toMatchObject({ code: 'reminder_time_required' });
  });
  it('does not replay Note content after the database revokes its permission', async () => {
    const h = harness();
    await executeVoiceWrite(
      h.ctx,
      'create_notebook_note',
      { notebook_id: user, title: 'note', content: 'text' },
      'voice_request_001',
      time
    );
    h.rpc.mockImplementation(async (name: string) =>
      name === 'begin_mcp_voice_operation_v1'
        ? { data: { ...h.op(), claimed: false }, error: null }
        : name === 'commit_mcp_voice_operation_v1'
          ? { data: null, error: { message: 'notebook_permission_denied' } }
          : { data: h.op(), error: null }
    );
    await expect(
      executeVoiceWrite(
        h.ctx,
        'create_notebook_note',
        { notebook_id: user, title: 'note', content: 'text' },
        'voice_request_001',
        time
      )
    ).rejects.toMatchObject({ code: 'notebook_permission_denied' });
  });
});

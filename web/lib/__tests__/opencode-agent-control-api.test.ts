import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/internal/opencode/control/route';
import {
  finishObservedOpenCodeTask,
  type OpenCodeTask,
} from '@/lib/opencode-agent-control';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc }),
}));
const secret = 'x'.repeat(40);
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { ok: true }, error: null });
  vi.stubEnv('WQN_OPENCODE_CONTROL_SECRET', secret);
});
afterEach(() => vi.unstubAllEnvs());
function request(body: unknown, token = secret) {
  return new Request('https://wqn.test/api/internal/opencode/control', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
it('authenticates before processing privileged payloads', async () => {
  expect(
    (await POST(request({ action: 'lookup', payload: {} }, 'wrong'))).status
  ).toBe(401);
  expect(rpc).not.toHaveBeenCalled();
});
it('does not expose task creation or cancellation through the plugin API', async () => {
  for (const action of ['arm', 'cancel'])
    expect((await POST(request({ action, payload: {} }))).status).toBe(422);
  expect(rpc).not.toHaveBeenCalled();
});
it('limits body size and rejects malformed bodies before invoking SQL', async () => {
  expect((await POST(request('x'.repeat(16385)))).status).toBe(413);
  expect((await POST(request('{'))).status).toBe(422);
  expect(rpc).not.toHaveBeenCalled();
});
it('delegates physical reservations and redacts database failure details', async () => {
  const body = { action: 'reserve', payload: { taskId: 'immutable-task' } };
  const ok = await POST(request(body));
  expect(ok.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('opencode_agent_control_v1', {
    p_action: 'reserve',
    p_payload: body.payload,
  });
  rpc.mockResolvedValue({
    data: null,
    error: { message: 'sensitive-provider-or-database-details' },
  });
  const denied = await POST(request(body));
  expect(denied.status).toBe(409);
  expect(await denied.text()).not.toContain('sensitive');
});
it('reconciles against the captured task ID, without looking up a newer admission', async () => {
  const task = { id: 'old-task', request_count: 1 } as OpenCodeTask;
  await finishObservedOpenCodeTask(
    task,
    'observe_ended',
    async () => 'succeeded'
  );
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('opencode_agent_control_v1', {
    p_action: 'finish',
    p_payload: { taskId: 'old-task', state: 'completed' },
  });
});
it('does not resolve ambiguous or never-sent tasks from stale session outcome', async () => {
  await finishObservedOpenCodeTask(
    { id: 'task', request_count: 1 } as OpenCodeTask,
    'client_closed',
    async () => 'succeeded'
  );
  await finishObservedOpenCodeTask(
    { id: 'task', request_count: 0 } as OpenCodeTask,
    'observe_ended',
    async () => 'succeeded'
  );
  expect(rpc).not.toHaveBeenCalled();
});

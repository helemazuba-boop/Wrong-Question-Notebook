import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createClients,
  runMarkTask,
  sessionIdForTask,
  messageIdForTask,
  workerConfig,
  verifyOpenCodeV2,
} from './worker.mjs';

function harness(options = {}) {
  const task = {
    run_id: randomUUID(),
    problem_id: randomUUID(),
    state: 'processing',
    session_id: null,
    prompt_state: 'new',
    task_token: 'a'.repeat(64),
    bundle_sha256: 'b'.repeat(64),
    deadline_at: new Date(Date.now() + 2000).toISOString(),
  };
  const calls = [];
  let session = null;
  let prompts = 0;
  let reads = 0;
  if (options.recover) {
    task.session_id = sessionIdForTask(task);
    task.prompt_state = options.uncertain ? 'submitting' : 'submitted';
    session = {
      id: task.session_id,
      metadata: { wqn_mark_run_id: task.run_id },
      model: { id: 'default', providerID: 'test' },
    };
  }
  const client = {
    async control(action, payload) {
      calls.push({ action, payload });
      if (action === 'read') {
        reads++;
        return options.noReceipt
          ? { state: 'processing' }
          : {
              state: 'committed',
              receipt: { accepted: true, run_id: task.run_id },
            };
      }
      return { ...task, ...payload };
    },
    async upstream(path, method = 'GET', body) {
      calls.push({ path, method, body });
      if (path === '/api/session' && method === 'POST') {
        session = { ...body, model: { id: 'default', providerID: 'test' } };
        return session;
      }
      if (path.endsWith('/prompt')) {
        prompts++;
        if (options.promptLost) throw new Error('connection lost');
        return null;
      }
      if (path.includes('/message?'))
        return options.promptPresent ? [{ id: messageIdForTask(task) }] : [];
      if (path.endsWith('/interrupt')) return null;
      if (!session) throw new Error('HTTP_404');
      return {
        ...session,
        ...(options.noReceipt ? { outcome: 'succeeded' } : {}),
      };
    },
  };
  return { task, client, calls, count: () => prompts, reads: () => reads };
}
const config = {
  directory: '/pinned/workspace',
  heartbeatMs: 10000,
  pollMs: 1,
};
test('admission rejects a V1 server before a task can invoke a model', async () => {
  await assert.rejects(
    verifyOpenCodeV2({ upstream: async () => ({ paths: { '/session': {} } }) }),
    /OPENCODE_V2_REQUIRED/
  );
  await verifyOpenCodeV2({
    upstream: async () => ({
      paths: {
        '/api/session': {},
        '/api/session/{sessionID}/prompt': {},
        '/api/event': {},
      },
    }),
  });
});
test('each task creates exactly one fresh session and submits exactly one prompt', async () => {
  const a = harness(),
    b = harness();
  await runMarkTask(a.task, a.client, config);
  await runMarkTask(b.task, b.client, config);
  assert.notEqual(sessionIdForTask(a.task), sessionIdForTask(b.task));
  for (const h of [a, b]) {
    assert.equal(
      h.calls.filter(x => x.path === '/api/session' && x.method === 'POST')
        .length,
      1
    );
    assert.equal(h.count(), 1);
    assert.equal(
      h.calls.find(x => x.path?.endsWith('/prompt')).body.id,
      messageIdForTask(h.task)
    );
  }
});
test('restart attaches the bound session without replaying the prompt', async () => {
  const h = harness({ recover: true });
  assert.equal((await runMarkTask(h.task, h.client, config)).accepted, true);
  assert.equal(h.count(), 0);
  assert.equal(h.calls.filter(x => x.path === '/api/session').length, 0);
});
test('a worker losing its lease leaves the session running for its successor', async () => {
  const h = harness({ recover: true });
  const control = h.client.control;
  const upstream = h.client.upstream;
  h.client.control = async (action, payload) => {
    if (action === 'renew') throw new Error('MARK_LEASE_LOST');
    if (action === 'read') return { state: 'processing' };
    return control(action, payload);
  };
  h.client.upstream = async (path, method, body, signal) => {
    if (path === `/api/session/${h.task.session_id}`) {
      // Hold the read until renewal is rejected, simulating a lease takeover
      // while the previous worker still has an upstream request in flight.
      if (signal?.aborted) throw signal.reason;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    }
    return upstream(path, method, body);
  };
  assert.equal(
    await runMarkTask(h.task, h.client, { ...config, heartbeatMs: 5 }),
    null
  );
  assert.equal(h.calls.filter(x => x.action === 'fail').length, 0);
  assert.equal(h.calls.filter(x => x.path?.endsWith('/interrupt')).length, 0);
  assert.equal(h.count(), 0);
});
test('uncertain submit recovery uses the original message identity', async () => {
  const h = harness({ recover: true, uncertain: true, promptPresent: true });
  await runMarkTask(h.task, h.client, config);
  assert.equal(h.count(), 0);
  assert.ok(
    h.calls.some(
      x => x.action === 'prompt' && x.payload.prompt_state === 'submitted'
    )
  );
});
test('a lost prompt response is reconciled, never replayed', async () => {
  const h = harness({ promptLost: true, promptPresent: true });
  await runMarkTask(h.task, h.client, config);
  assert.equal(h.count(), 1);
});
test('an absent prompt after an uncertain outcome is explicit and not replayed', async () => {
  const h = harness({ recover: true, uncertain: true, noReceipt: true });
  await assert.rejects(
    runMarkTask(h.task, h.client, config),
    /PROMPT_OUTCOME_UNKNOWN/
  );
  assert.equal(h.count(), 0);
  assert.ok(
    h.calls.some(
      x =>
        x.action === 'fail' && x.payload.error_code === 'PROMPT_OUTCOME_UNKNOWN'
    )
  );
});
test('a successful conversation without an accepted WQN receipt fails', async () => {
  const h = harness({ noReceipt: true });
  await assert.rejects(
    runMarkTask(h.task, h.client, config),
    /WITHOUT_RECEIPT/
  );
});
test('an expired task does not create an upstream session', async () => {
  const h = harness({ noReceipt: true });
  h.task.deadline_at = new Date(Date.now() - 1).toISOString();
  await assert.rejects(runMarkTask(h.task, h.client, config), /DEADLINE/);
  assert.equal(h.calls.filter(x => x.path === '/api/session').length, 0);
});
test('the client speaks the v2 envelope, scoped directory and explicit model omission', async () => {
  const requests = [];
  const c = createClients(
    {
      appUrl: 'http://wqn',
      serverUrl: 'http://opencode',
      directory: '/资料',
      secret: 'x',
      username: 'opencode',
      password: '',
    },
    'worker',
    async (url, init) => {
      requests.push({ url: new URL(url), init });
      return new Response(JSON.stringify({ data: { id: 'ses_test' } }));
    }
  );
  assert.equal(
    (await c.upstream('/api/session', 'POST', { agent: 'mark' })).id,
    'ses_test'
  );
  assert.equal(requests[0].url.searchParams.get('directory'), '/资料');
  assert.equal(JSON.parse(requests[0].init.body).model, undefined);
});
test('configuration preserves rag default and validates agent admission', () => {
  assert.equal(workerConfig({}).engine, 'rag');
  assert.throws(
    () => workerConfig({ PROBLEM_MARKING_ENGINE: 'agent' }),
    /NOT_CONFIGURED/
  );
});

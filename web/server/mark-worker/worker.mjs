import { randomUUID } from 'node:crypto';

export class MarkWorkerError extends Error {}
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
export function workerConfig(env = process.env) {
  const engine = env.PROBLEM_MARKING_ENGINE ?? 'rag';
  if (!['rag', 'agent'].includes(engine))
    throw new Error('INVALID_MARKING_ENGINE');
  const config = {
    engine,
    appUrl: env.WQN_MARK_APP_URL ?? 'http://wqn:3000',
    secret: env.PROBLEM_MARKING_AGENT_SECRET ?? '',
    serverUrl: env.WQN_MARK_OPENCODE_URL ?? '',
    directory: env.WQN_MARK_OPENCODE_DIRECTORY ?? '',
    username: env.WQN_MARK_OPENCODE_USERNAME ?? 'opencode',
    password: env.WQN_MARK_OPENCODE_PASSWORD ?? '',
    concurrency: Number(env.WQN_MARK_CONCURRENCY ?? 2),
    pollMs: 2000,
    heartbeatMs: 20000,
  };
  if (
    !Number.isInteger(config.concurrency) ||
    config.concurrency < 1 ||
    config.concurrency > 16
  )
    throw new Error('INVALID_MARK_CONCURRENCY');
  if (engine === 'agent') {
    if (config.secret.length < 32 || !config.directory)
      throw new Error('MARK_WORKER_NOT_CONFIGURED');
    for (const address of [config.appUrl, config.serverUrl])
      if (!['http:', 'https:'].includes(new URL(address).protocol))
        throw new Error('INVALID_MARK_URL');
  }
  return config;
}
export function createClients(
  config,
  workerId = randomUUID(),
  fetcher = fetch
) {
  async function request(url, init = {}, signal, timeout = 20000) {
    const response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new MarkWorkerError('INVALID_UPSTREAM_JSON');
    }
    if (!response.ok)
      throw new MarkWorkerError(
        data?.error?.code ?? data?.error ?? `HTTP_${response.status}`
      );
    return data;
  }
  return {
    workerId,
    async control(action, payload = {}, signal) {
      const body = await request(
        new URL('/api/internal/problem-marks/agent', config.appUrl),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.secret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action, worker_id: workerId, ...payload }),
        },
        signal
      );
      return body.data;
    },
    async upstream(route, method = 'GET', body, signal, timeout) {
      const url = new URL(route, config.serverUrl);
      url.searchParams.set('directory', config.directory);
      const headers = {
        Accept: 'application/json',
        'x-opencode-directory': encodeURIComponent(config.directory),
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (config.password)
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
      const value = await request(
        url,
        {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        signal,
        timeout
      );
      return value?.data ?? value;
    },
  };
}
export function sessionIdForTask(task) {
  return `ses_${task.run_id.replaceAll('-', '')}`;
}
export function messageIdForTask(task) {
  return `msg_${task.run_id.replaceAll('-', '')}`;
}

export async function verifyOpenCodeV2(clients) {
  const schema = await clients.upstream('/openapi.json');
  const paths = Object.keys(schema?.paths ?? {});
  if (
    !paths.includes('/api/session') ||
    !paths.some(p => /^\/api\/session\/\{[^}]+\}\/prompt$/.test(p)) ||
    !paths.includes('/api/event')
  ) {
    throw new MarkWorkerError('OPENCODE_V2_REQUIRED');
  }
}

/** One claimed task owns exactly one new session. Recovery reuses that session. */
export async function runMarkTask(task, clients, config, shutdownSignal) {
  if (task.state !== 'processing') {
    if (task.session_id && task.state !== 'committed')
      await clients
        .upstream(`/api/session/${task.session_id}/interrupt`, 'POST', {})
        .catch(() => {});
    return task.receipt ?? null;
  }
  const controller = new AbortController();
  const remaining = Date.parse(task.deadline_at) - Date.now();
  const deadlineTimer = setTimeout(
    () => controller.abort(new MarkWorkerError('AGENT_DEADLINE_EXCEEDED')),
    Math.max(0, remaining)
  );
  const signal = AbortSignal.any([
    controller.signal,
    ...(shutdownSignal ? [shutdownSignal] : []),
  ]);
  const leaveForRecovery = () =>
    shutdownSignal?.aborted ||
    controller.signal.reason?.message === 'MARK_LEASE_LOST';
  const run = { run_id: task.run_id };
  let renewing = false;
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const renewed = await clients.control('renew', run, signal);
      if (renewed.state !== 'processing')
        throw new MarkWorkerError('MARK_TASK_REPLACED');
    } catch {
      controller.abort(new MarkWorkerError('MARK_LEASE_LOST'));
    } finally {
      renewing = false;
    }
  }, config.heartbeatMs);
  const sessionId = task.session_id ?? sessionIdForTask(task);
  const messageId = messageIdForTask(task);
  const started = Date.now();
  let accepted = false;
  async function hasPrompt() {
    const messages = await clients.upstream(
      `/api/session/${sessionId}/message?limit=100&order=desc`,
      'GET',
      undefined,
      signal
    );
    return (
      Array.isArray(messages) &&
      messages.some(message => message.id === messageId)
    );
  }
  try {
    if (remaining <= 0) throw new MarkWorkerError('AGENT_DEADLINE_EXCEEDED');
    if (!task.session_id)
      await clients.control('bind', { ...run, session_id: sessionId }, signal);
    let session;
    try {
      session = await clients.upstream(
        `/api/session/${sessionId}`,
        'GET',
        undefined,
        signal
      );
    } catch (error) {
      if (error.message !== 'HTTP_404' && error.message !== 'not_found')
        throw error;
      try {
        await clients.upstream(
          '/api/session',
          'POST',
          {
            id: sessionId,
            title: `WQN mark ${task.problem_id}`,
            agent: 'mark',
            location: { directory: config.directory },
            metadata: {
              wqn_mark_run_id: task.run_id,
              bundle_sha256: task.bundle_sha256,
            },
          },
          signal
        );
      } catch {
        // The create may have succeeded. Read the deterministic identity, never create a second session.
      }
      session = await clients.upstream(
        `/api/session/${sessionId}`,
        'GET',
        undefined,
        signal
      );
    }
    if (
      session?.id !== sessionId ||
      session.metadata?.wqn_mark_run_id !== task.run_id
    )
      throw new MarkWorkerError('MARK_SESSION_MISMATCH');
    await clients.control(
      'telemetry',
      {
        ...run,
        telemetry: {
          session_id: sessionId,
          model: session.model
            ? `${session.model.providerID}/${session.model.id}`
            : null,
        },
      },
      signal
    );
    if (task.prompt_state === 'new') {
      await clients.control(
        'prompt',
        { ...run, prompt_state: 'submitting' },
        signal
      );
      try {
        await clients.upstream(
          `/api/session/${sessionId}/prompt`,
          'POST',
          {
            id: messageId,
            text: `Classify exactly one WQN Problem. Load the mark skill, then call wqn_mark_get_mark_context. run_id=${task.run_id} task_token=${task.task_token}. The pinned bundle SHA256 is ${task.bundle_sha256}. Deadline: ${task.deadline_at}. Submit via WQN marking MCP and obtain an accepted receipt.`,
            delivery: 'queue',
          },
          signal,
          Math.min(
            60000,
            Math.max(1, Date.parse(task.deadline_at) - Date.now())
          )
        );
      } catch {
        if (!(await hasPrompt()))
          throw new MarkWorkerError('PROMPT_OUTCOME_UNKNOWN');
      }
      await clients.control(
        'prompt',
        { ...run, prompt_state: 'submitted' },
        signal
      );
    } else if (task.prompt_state === 'submitting') {
      if (!(await hasPrompt()))
        throw new MarkWorkerError('PROMPT_OUTCOME_UNKNOWN');
      await clients.control(
        'prompt',
        { ...run, prompt_state: 'submitted' },
        signal
      );
    }
    for (;;) {
      const current = await clients.control('read', run, signal);
      if (current.receipt?.accepted) {
        accepted = true;
        return current.receipt;
      }
      if (current.state !== 'processing')
        throw new MarkWorkerError(current.error_code ?? 'MARK_TASK_NOT_ACTIVE');
      session = await clients.upstream(
        `/api/session/${sessionId}`,
        'GET',
        undefined,
        signal
      );
      if (session.outcome) {
        // Check the durable receipt again: completion and receipt reads can race.
        const latest = await clients.control('read', run, signal);
        if (latest.receipt?.accepted) {
          accepted = true;
          return latest.receipt;
        }
        throw new MarkWorkerError(
          session.outcome === 'succeeded'
            ? 'AGENT_FINISHED_WITHOUT_RECEIPT'
            : 'AGENT_EXECUTION_FAILED'
        );
      }
      await wait(config.pollMs, signal);
    }
  } catch (error) {
    // A failed renewal does not prove task failure. A successor may already own
    // this session; leave both the task and upstream execution for recovery.
    if (leaveForRecovery()) return null;
    try {
      const latest = await clients.control('read', run);
      if (latest.receipt?.accepted) {
        accepted = true;
        return latest.receipt;
      }
    } catch {
      /* Preserve uncertainty; never replay model input here. */
    }
    const code = controller.signal.aborted
      ? controller.signal.reason?.message
      : error?.message;
    await clients
      .control('fail', {
        ...run,
        error_code: /^[A-Z_]+$/.test(code) ? code : 'MARK_TRANSPORT_FAILED',
      })
      .catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(heartbeat);
    if (!leaveForRecovery()) {
      await clients
        .upstream(`/api/session/${sessionId}/interrupt`, 'POST', {})
        .catch(() => {});
      const final = await clients
        .upstream(`/api/session/${sessionId}`)
        .catch(() => null);
      const messages = await clients
        .upstream(`/api/session/${sessionId}/message?limit=100&order=desc`)
        .catch(() => null);
      const toolCounts = {};
      if (Array.isArray(messages))
        for (const message of messages)
          for (const part of message.content ?? []) {
            if (part.type === 'tool') {
              const name = part.tool ?? part.name ?? 'unknown';
              toolCounts[name] = (toolCounts[name] ?? 0) + 1;
            }
          }
      await clients
        .control('telemetry', {
          ...run,
          telemetry: {
            session_id: sessionId,
            model: final?.model
              ? `${final.model.providerID}/${final.model.id}`
              : null,
            tokens: final?.tokens ?? null,
            cost_usd: final?.cost ?? null,
            execution_ms: Date.now() - (Date.parse(task.created_at) || started),
            queue_ms: Math.max(
              0,
              (Date.parse(task.created_at) || started) -
                (Date.parse(task.queued_at) || started)
            ),
            end_to_end_ms: Date.now() - (Date.parse(task.queued_at) || started),
            accepted,
            outcome: final?.outcome ?? null,
            model_steps: Array.isArray(messages)
              ? messages.filter(m => m.type === 'assistant').length
              : null,
            tool_counts: Array.isArray(messages) ? toolCounts : null,
            history_truncated: Array.isArray(messages)
              ? messages.length >= 100
              : null,
          },
        })
        .catch(() => {});
    }
  }
}

export async function workerLoop(config, slot, signal, onState = () => {}) {
  const clients = createClients(config, `${randomUUID()}:${slot}`);
  while (!signal.aborted) {
    try {
      const task = await clients.control('claim', {}, signal);
      if (task) {
        onState({ slot, run_id: task.run_id, state: task.state });
        await runMarkTask(task, clients, config, signal);
      } else await wait(1000, signal);
    } catch (error) {
      if (signal.aborted) return;
      onState({
        slot,
        state: 'error',
        code: /^[A-Z_0-9]+$/.test(error.message)
          ? error.message
          : 'MARK_WORKER_ERROR',
      });
      await wait(1000, signal).catch(() => {});
    } finally {
      onState({ slot, state: 'idle' });
    }
  }
}

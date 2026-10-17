// OpenCode v2 native hooks. No session prompt replay and no global model edits.
import { randomUUID } from 'node:crypto';

const ID = 'wqn.agent-control.v1';
const selector = model =>
  `${model.providerID}/${model.id}${model.variant && model.variant !== 'default' ? `#${model.variant}` : ''}`;
export function classifyProviderFailure(status, code = '') {
  if (
    status === 402 ||
    [
      'insufficient_quota',
      'insufficient_balance',
      'quota_exceeded',
      'credit_balance_too_low',
      'balance_not_enough',
    ].includes(String(code).toLowerCase())
  )
    return 'quota_exhausted';
  if (status === 429) return 'rate_limited';
  return [503, 529].includes(status) ? 'unavailable' : 'ineligible';
}

export function createControlClient(url, secret, fetcher = fetch) {
  if (!secret || secret.length < 32)
    throw new Error('WQN control secret must contain at least 32 characters');
  const target = new URL(url);
  if (
    target.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  )
    throw new Error('WQN control requires HTTPS or loopback');
  return async (action, payload) => {
    const response = await fetcher(target, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('WQN control denied request');
    const body = await response.json();
    if (!Object.hasOwn(body, 'data'))
      throw new Error('WQN control response is invalid');
    return body.data;
  };
}

/** Exported for integration tests; production setup uses the real HTTP client. */
export async function installControl(
  ctx,
  { control, scope, routes, fetcher = fetch }
) {
  if (!/^[a-f0-9]{64}$/.test(scope) || !Array.isArray(routes) || !routes.length)
    throw new Error('Invalid WQN control configuration');
  const routeMap = new Map();
  for (const route of routes) {
    const url = new URL(route.url);
    if (
      route.protocol !== 'openai-chat' ||
      !url.pathname.endsWith('/chat/completions') ||
      (url.protocol !== 'https:' &&
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
      !Number.isSafeInteger(route.contextTokens) ||
      route.contextTokens <= 0 ||
      !route.outputBoundIncludesReasoning ||
      !route.selector
    )
      throw new Error('Unsupported or unbounded WQN model route');
    if (routeMap.has(route.selector))
      throw new Error('Duplicate WQN model route');
    const generationKeys = Object.keys(route.generation ?? {});
    if (
      generationKeys.some(
        key =>
          ![
            'temperature',
            'top_p',
            'reasoning_effort',
            'thinking',
            'enable_thinking',
          ].includes(key)
      ) ||
      (route.selector.includes('#') && generationKeys.length === 0)
    )
      throw new Error(
        'WQN variants require an explicit bounded generation mapping'
      );
    routeMap.set(route.selector, route);
  }
  const registrations = [];
  const inFlight = new Map();
  async function taskFor(sessionID) {
    let id = sessionID;
    for (let depth = 0; depth < 16; depth++) {
      const task = await control('lookup', { scope, sessionId: id });
      if (task) {
        if (id !== sessionID)
          await control('bind', { taskId: task.id, sessionId: sessionID });
        return task;
      }
      const result = await ctx.session.get({ sessionID: id });
      const session = result.data ?? result;
      if (!session.parentID) return null;
      id = session.parentID;
    }
    throw new Error('WQN session ancestry exceeds limit');
  }
  const active = task => {
    if (
      !['armed', 'running'].includes(task.state) ||
      Date.now() >= Date.parse(task.deadline)
    )
      throw new Error('WQN task stopped');
  };
  const hook = async (name, callback) =>
    registrations.push(await ctx.session.hook(name, callback));
  await hook('prompt', async event => {
    const task = await taskFor(event.sessionID);
    if (!task) {
      if (event.metadata?.wqn_task_id)
        throw new Error('WQN task scope is not configured in this plugin');
      return;
    }
    active(task);
    if (
      event.sessionID === task.session_id &&
      event.metadata?.wqn_task_id !== task.id
    )
      throw new Error('WQN managed sessions require a task admission');
  });
  // Bound every flow; auxiliary calls cannot escape accounting. Title is
  // supplied locally, while compaction/generate are metered like primary.
  for (const kind of ['context', 'compaction', 'generate', 'title']) {
    await hook(kind, async event => {
      const task = await taskFor(event.sessionID);
      if (!task) return;
      active(task);
      if (kind === 'title') {
        event.result = 'WQN Agent';
        return;
      }
      event.options.maxTokens = task.policy.limits.maxOutputTokens;
    });
  }
  await hook('retry', async event => {
    if (await taskFor(event.sessionID)) event.decision = { retry: false };
  });
  await hook('experimental.ws.handshake', async event => {
    if (await taskFor(event.sessionID))
      throw new Error('WQN strict control requires metered HTTP');
  });
  registrations.push(
    await ctx.tool.hook('execute.before', async event => {
      const task = await taskFor(event.sessionID);
      if (task) {
        active(task);
        await control('activity', { taskId: task.id, tool: true });
      }
    })
  );

  async function boundedRequest(task, request, model, kind) {
    active(task);
    const route = routeMap.get(model);
    if (!route) throw new Error('WQN model route is not allowed');
    // Reserve the model's ENTIRE accepted context window, not a character
    // estimate. This intentionally conservative bound includes hidden framing,
    // system instructions and tools. Operator metadata may never understate
    // the catalog's configured context window.
    const slash = model.indexOf('/');
    const hash = model.indexOf('#');
    const inventory = await ctx.model.list();
    const catalog = (inventory.data ?? inventory).find(
      m =>
        m.providerID === model.slice(0, slash) &&
        m.id === model.slice(slash + 1, hash < 0 ? undefined : hash)
    );
    if (
      catalog?.package !== '@opencode/ai/providers/openai-compatible' ||
      !catalog?.enabled ||
      !catalog.capabilities?.tools ||
      !Number.isSafeInteger(catalog.limit?.context) ||
      catalog.limit.context <= 0 ||
      catalog.limit.context > route.contextTokens
    )
      throw new Error('WQN model catalog or context bound is invalid');
    const body = await request.clone().json();
    if (
      !Array.isArray(body.messages) ||
      (body.n && body.n !== 1) ||
      body.responses ||
      body.input
    )
      throw new Error('WQN requires single-choice OpenAI chat requests');
    if (!(route.modelID ?? catalog.modelID))
      throw new Error('WQN provider model ID is missing');
    body.model = route.modelID ?? catalog.modelID;
    if (model !== task.policy.primary) {
      for (const key of ['reasoning_effort', 'thinking', 'enable_thinking'])
        delete body[key];
    }
    Object.assign(body, route.generation ?? {});
    body.max_tokens = task.policy.limits.maxOutputTokens;
    delete body.max_completion_tokens;
    body.n = 1;
    if (body.stream)
      body.stream_options = {
        ...(body.stream_options ?? {}),
        include_usage: true,
      };
    const headers = new Headers({ 'content-type': 'application/json' });
    const key = route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined;
    if (route.apiKeyEnv && !key)
      throw new Error('WQN route credential is unavailable');
    if (key) headers.set('authorization', `Bearer ${key}`);
    const attemptId = randomUUID();
    // A repeated physical send never reuses an accepted reservation ID.
    await control('reserve', {
      taskId: task.id,
      attemptId,
      model,
      kind,
      inputTokens: route.contextTokens,
      outputTokens: body.max_tokens,
    });
    headers.set('x-wqn-attempt-id', attemptId);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(Math.max(1, Date.parse(task.deadline) - Date.now())),
    ]);
    const outgoing = new Request(route.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    return {
      request: outgoing,
      template: outgoing.clone(),
      task,
      attemptId,
      model,
      kind,
    };
  }
  await hook('http.request', async event => {
    let task = await taskFor(event.sessionID);
    if (!task) return;
    active(task);
    if (task.primary_cooling && !task.fallback_count) {
      await control('fallback', {
        taskId: task.id,
        reason: 'model_unavailable',
      });
      task = await taskFor(event.sessionID);
    }
    if (
      ![task.policy.primary, task.policy.fallback].includes(
        selector(event.model)
      )
    )
      throw new Error('WQN session model drifted');
    const attempt = await boundedRequest(
      task,
      event.request,
      task.actual_model ?? task.policy.primary,
      event.kind
    );
    inFlight.set(attempt.attemptId, attempt);
    attempt.request.signal.addEventListener(
      'abort',
      () => inFlight.delete(attempt.attemptId),
      { once: true }
    );
    event.request = attempt.request;
  });

  async function responseWithAccounting(attempt, response) {
    if (!response.ok || !response.body) {
      await control('settle', {
        taskId: attempt.task.id,
        attemptId: attempt.attemptId,
        usedTokens: null,
      });
      return response;
    }
    // Mark BEFORE exposing the response to the runner. A partial stream may
    // never trigger task replay, even if the text decoder later fails.
    await control('activity', { taskId: attempt.task.id, output: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usedTokens = null;
    let settled = false;
    async function settle() {
      if (settled) return;
      settled = true;
      await control('settle', {
        taskId: attempt.task.id,
        attemptId: attempt.attemptId,
        usedTokens,
      });
    }
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            await settle();
            controller.close();
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          if (buffer.length > 1_048_576)
            throw new Error('WQN provider frame is too large');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try {
              const usage = JSON.parse(line.slice(5).trim()).usage;
              if (
                usage &&
                Number.isSafeInteger(usage.total_tokens) &&
                usage.total_tokens >= 0
              )
                usedTokens = usage.total_tokens;
            } catch {
              /* fragmented or non-JSON SSE, reservation stays intact */
            }
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          await reader.cancel().catch(() => {});
          await settle().catch(() => {});
          controller.error(error);
        }
      },
      async cancel() {
        await reader.cancel();
        await settle();
      },
    });
    return new Response(stream, {
      status: response.status,
      headers: response.headers,
    });
  }
  async function recordFailure(attempt, response) {
    let errorCode = '';
    try {
      const copy = response.clone();
      const reader = copy.body?.getReader();
      let text = '';
      const readDeadline = Date.now() + 2000;
      if (reader) {
        try {
          for (;;) {
            let readTimer;
            const chunk = await Promise.race([
              reader.read(),
              new Promise((_, reject) => {
                readTimer = setTimeout(
                  () => reject(new Error('Provider error timeout')),
                  Math.max(1, readDeadline - Date.now())
                );
                readTimer.unref?.();
              }),
            ]).finally(() => clearTimeout(readTimer));
            if (chunk.done) break;
            text += new TextDecoder().decode(chunk.value);
            if (text.length > 16_384) break;
          }
        } finally {
          void reader.cancel().catch(() => {});
        }
      }
      const raw = text.length <= 16_384 ? JSON.parse(text) : {};
      errorCode = raw?.error?.code ?? raw?.error?.type ?? raw?.code ?? '';
    } catch {
      /* classification falls back to an explicit provider status */
    }
    const reason = classifyProviderFailure(response.status, errorCode);
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter
      ? /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - Date.now()
      : 0;
    const retryAfterMs = Number.isFinite(delay)
      ? Math.min(86_400_000, Math.max(0, Math.ceil(delay)))
      : 0;
    await control('failure', {
      taskId: attempt.task.id,
      model: attempt.model,
      reason,
      status: response.status,
      retryAfterMs,
      code: String(errorCode).slice(0, 128),
    });
    return reason;
  }
  await hook('http.response', async event => {
    const attemptId = event.request.headers.get('x-wqn-attempt-id');
    const attempt = inFlight.get(attemptId);
    if (!attempt) {
      if (await taskFor(event.sessionID))
        throw new Error('WQN response has no reservation');
      return;
    }
    inFlight.delete(attemptId);
    let response = event.response;
    let current = attempt;
    if (!response.ok) {
      const reason = await recordFailure(attempt, response);
      if (reason !== 'ineligible') {
        void response.body?.cancel().catch(() => {});
        await control('settle', {
          taskId: attempt.task.id,
          attemptId: attempt.attemptId,
          usedTokens: null,
        });
        // SQL atomically rejects a second switch, output/tool activity, a
        // different quota pool requirement, cancellation and daily limits.
        await control('fallback', { taskId: attempt.task.id, reason });
        const task = await taskFor(event.sessionID);
        current = await boundedRequest(
          task,
          attempt.template,
          task.actual_model,
          event.kind
        );
        // Exactly one direct send; it is outside native retry machinery.
        response = await fetcher(current.request);
        if (!response.ok) await recordFailure(current, response);
      }
    }
    event.response = await responseWithAccounting(current, response);
  });

  // Task completion belongs to the gateway holding the immutable task ID.
  // Public terminal events have no admission identity and must never finish
  // the latest task merely because they reuse a session ID.
  return async () => {
    await Promise.all(registrations.map(r => r.dispose()));
  };
}

const plugin = {
  id: ID,
  async setup(ctx) {
    const options = ctx.options;
    const control = createControlClient(
      options.controlUrl,
      process.env.WQN_OPENCODE_CONTROL_SECRET
    );
    return installControl(ctx, {
      control,
      scope: options.scope,
      routes: options.routes,
    });
  },
};

export default plugin;

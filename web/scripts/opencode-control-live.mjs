// Windows-only, isolated OpenCode v2 + local fake providers + real PostgreSQL.
// The default matrix uses no provider credentials. SQL uses stdin, never argv.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('Run with Windows node.exe');
const root = path.join(process.env.TEMP, `wqn-opencode-live-${Date.now()}`);
fs.mkdirSync(root);
const database = process.env.PGDATABASE ?? 'wqn_opencode_control_20261017';
if (!database.startsWith('wqn_opencode_control_'))
  throw new Error('Isolated test database required');
function sql(statement) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'wsl.exe',
      [
        '-d',
        'Ubuntu',
        '--',
        'psql',
        '-X',
        '-qAt',
        '-h',
        '/tmp',
        '-p',
        '55439',
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let out = '',
      err = '';
    child.stdout.on('data', x => {
      out += x;
    });
    child.stderr.on('data', x => {
      err += x;
    });
    child.on('error', reject);
    child.on('exit', code =>
      code ? reject(new Error(err)) : resolve(out.trim())
    );
    child.stdin.end(statement);
  });
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
async function control(action, payload) {
  return JSON.parse(
    await sql(
      `select public.opencode_agent_control_v1(${quote(action)},${quote(JSON.stringify(payload))}::jsonb);`
    )
  );
}
let scenario,
  realUsage,
  calls = [];
const secret = randomUUID() + randomUUID();
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/control') {
      assert.equal(req.headers.authorization, `Bearer ${secret}`);
      res.setHeader('content-type', 'application/json');
      try {
        res.end(
          JSON.stringify({ data: await control(body.action, body.payload) })
        );
      } catch (error) {
        console.log('Control denial:', body.action, error.message);
        res.statusCode = 409;
        res.end('{"error":"control_denied"}');
      }
      return;
    }
    calls.push({
      route: req.url,
      maxTokens: body.max_tokens,
      attempt: req.headers['x-wqn-attempt-id'],
      model: body.model,
    });
    assert.equal(body.max_tokens, 64);
    assert.equal(body.n, 1);
    if (scenario === 'real') {
      const config = JSON.parse(
        fs.readFileSync(
          path.join(process.env.USERPROFILE, '.config/opencode/opencode.json')
        )
      );
      const settings = config.provider.stepfun.options;
      const target = new URL(
        settings.baseURL.replace(/\/$/, '') + '/chat/completions'
      );
      assert.equal(target.origin, 'https://api.stepfun.com');
      assert.equal(body.model, 'step-3.7-flash');
      const upstream = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      const text = await upstream.text();
      if (upstream.ok) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const usage = JSON.parse(line.slice(5)).usage;
            if (usage) realUsage = usage;
          } catch {}
        }
        assert.ok(
          realUsage && realUsage.completion_tokens <= 64,
          'Provider did not prove the bounded completion usage'
        );
      }
      res.statusCode = upstream.status;
      res.setHeader(
        'content-type',
        upstream.headers.get('content-type') ?? 'application/json'
      );
      res.end(text);
      return;
    }
    if (req.url.startsWith('/primary') || scenario === 'both429') {
      res.statusCode = scenario === 'balance' ? 403 : 429;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            message: 'Injected provider failure',
            code:
              scenario === 'balance'
                ? 'insufficient_balance'
                : 'rate_limit_exceeded',
          },
        })
      );
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'WQN_CONTROL_OK' },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ])
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: 1, model: body.model, ...chunk })}\n\n`
      );
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const primary = 'stepfun/step-3.7-flash';
const fallback = 'opencode/deepseek-v4.1-flash-free';
fs.cpSync(process.env.WQN_PLUGIN_SOURCE, path.join(root, 'plugin'), {
  recursive: true,
});
// The gateway's scope algorithm is based on the stable binding base URL.
const scope = createHash('sha256')
  .update(`isolated-live\0${root}`)
  .digest('hex');
const options = {
  controlUrl: `http://127.0.0.1:${port}/control`,
  scope,
  routes: [primary, fallback].map((selector, index) => ({
    selector,
    protocol: 'openai-chat',
    url: `http://127.0.0.1:${port}/${index ? 'backup' : 'primary'}/chat/completions`,
    contextTokens: 2_000_000,
    outputBoundIncludesReasoning: true,
  })),
};
fs.writeFileSync(
  path.join(root, 'opencode.json'),
  JSON.stringify({ plugins: [{ package: './plugin', options }] })
);
let log = '',
  errors = '';
const child = spawn(
  path.join(
    process.env.APPDATA,
    'ai.opencode.desktop/cli/2.0.16/opencode-cli.exe'
  ),
  ['serve', '--hostname', '127.0.0.1', '--port', '0'],
  {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_DB: path.join(root, 'isolated.db'),
      WQN_OPENCODE_CONTROL_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
child.stdout.on('data', x => {
  log += x;
});
child.stderr.on('data', x => {
  errors += x;
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 300 && !/server password\s+\S+/.test(log); i++)
    await sleep(100);
  const base = log.match(/http:\/\/127.0.0.1:\d+/)?.[0];
  const password = log.match(/server password\s+(\S+)/)?.[1];
  assert.ok(base && password, 'Isolated server did not start');
  const headers = {
    authorization:
      'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
    'content-type': 'application/json',
    'x-opencode-directory': root,
  };
  async function api(url, body) {
    const r = await fetch(base + url, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    assert.equal(r.status, 200, `API failed ${url}: ${JSON.stringify(data)}`);
    return data.data;
  }
  const capture = new AbortController();
  const stream = await fetch(base + '/api/event', {
    headers,
    signal: capture.signal,
  });
  let eventText = '';
  void (async () => {
    try {
      for await (const chunk of stream.body)
        eventText += new TextDecoder().decode(chunk);
    } catch {}
  })();
  let plugins;
  for (let i = 0; i < 100; i++) {
    plugins = await api('/api/plugin');
    if (
      plugins.some(
        p => p.id === 'wqn.agent-control.v1' && p.state.status === 'active'
      )
    )
      break;
    await sleep(100);
  }
  assert.ok(
    plugins.some(
      p => p.id === 'wqn.agent-control.v1' && p.state.status === 'active'
    ),
    'Control plugin is not active: ' +
      JSON.stringify(plugins.filter(p => p.source.type !== 'builtin'))
  );
  console.log('PASS native plugin active');
  const limits = {
    maxInputTokens: 2_000_000,
    maxOutputTokens: 64,
    maxTotalTokens: 9_000_000,
    maxProviderRequests: 3,
    maxSteps: 3,
    maxDurationMs: 60000,
    maxFallbacksPer24Hours: 3,
    maxUserTokensPer24Hours: 20_000_000,
    cooldownMs: 1000,
    quotaGroups: { [primary]: 'independent-a', [fallback]: 'independent-b' },
  };
  const results = [];
  for (scenario of process.argv.includes('--real-stepfun')
    ? ['real']
    : ['429', 'balance', 'both429', 'budget']) {
    calls = [];
    const userId = randomUUID(),
      deviceId = randomUUID();
    await sql(
      `insert into public.esp32_devices(id) values (${quote(deviceId)});`
    );
    const session = await api('/api/session', {
      model: { providerID: 'stepfun', id: 'step-3.7-flash' },
    });
    const task = await control('arm', {
      scope,
      userId,
      deviceId,
      sessionId: session.id,
      requestId: randomUUID().replaceAll('-', '').slice(0, 16),
      policy: {
        primary,
        fallback,
        limits: {
          ...limits,
          ...(scenario === 'budget' ? { maxProviderRequests: 1 } : {}),
        },
      },
    });
    const prompt = {
      id: 'msg_wqn_' + task.id.replaceAll('-', ''),
      text: 'Reply WQN_CONTROL_OK. Do not use tools.',
      metadata: { wqn_task_id: task.id },
    };
    await api(`/api/session/${session.id}/prompt`, prompt);
    let outcome;
    for (let i = 0; i < 300; i++) {
      const detail = await api(`/api/session/${session.id}`);
      if (detail.outcome) {
        outcome = detail.outcome;
        break;
      }
      await sleep(100);
    }
    if (
      outcome !==
      (['both429', 'budget'].includes(scenario) ? 'failed' : 'succeeded')
    ) {
      fs.writeFileSync(path.join(root, 'events.txt'), eventText);
      console.log('Failure evidence:', root);
    }
    assert.equal(
      outcome,
      ['both429', 'budget'].includes(scenario) ? 'failed' : 'succeeded',
      `${scenario}: ${JSON.stringify(calls)}`
    );
    const stored = await control('lookup', { scope, sessionId: session.id });
    assert.equal(calls.length, ['budget', 'real'].includes(scenario) ? 1 : 2);
    assert.equal(stored.request_count, calls.length);
    assert.equal(stored.fallback_count, scenario === 'real' ? 0 : 1);
    if (scenario === 'real')
      assert.equal(stored.reserved_tokens, realUsage.total_tokens);
    assert.equal(new Set(calls.map(c => c.attempt)).size, calls.length);
    // Re-admitting the identical message ID must not send another model call.
    await api(`/api/session/${session.id}/prompt`, prompt);
    await sleep(500);
    assert.equal(calls.length, ['budget', 'real'].includes(scenario) ? 1 : 2);
    await control('finish', {
      taskId: task.id,
      state: outcome === 'succeeded' ? 'completed' : 'failed',
    });
    results.push({
      scenario,
      outcome,
      physicalCalls: calls.length,
      ledgerCalls: stored.request_count,
      fallbackCount: stored.fallback_count,
      ...(scenario === 'real' ? { usage: realUsage } : {}),
    });
    console.log('PASS', JSON.stringify(results.at(-1)));
  }
  capture.abort();
  fs.writeFileSync(
    path.join(root, 'result.json'),
    JSON.stringify({ results }, null, 2)
  );
  console.log('Evidence:', root);
} finally {
  child.kill();
  server.closeAllConnections();
  server.close();
  fs.writeFileSync(
    path.join(root, 'diagnostics.txt'),
    errors.replaceAll(secret, '<redacted>')
  );
}

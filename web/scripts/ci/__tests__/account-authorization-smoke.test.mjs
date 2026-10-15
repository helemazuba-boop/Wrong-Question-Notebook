import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const script = fileURLToPath(
  new URL('../account-authorization-smoke.mjs', import.meta.url)
);
const fake = {
  SERVICE_ROLE_KEY: 'FAKE-CI-SERVICE-KEY',
  ANON_KEY: 'FAKE-CI-ANON-KEY',
  JWT_SECRET: 'FAKE-CI-JWT-SECRET',
};
async function run(api) {
  const dir = await mkdtemp(join(tmpdir(), 'wqn-review-security-'));
  const file = join(dir, 'status.json');
  try {
    await writeFile(file, JSON.stringify({ API_URL: api, ...fake }), {
      mode: 0o600,
    });
    try {
      const r = await exec(process.execPath, [script, file], {
        timeout: 10000,
      });
      return { code: 0, ...r };
    } catch (r) {
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
test('non-loopback destinations are rejected before sending file-derived keys', async () => {
  for (const api of [
    'https://outside.example.invalid',
    'http://localhost.outside.invalid',
    'http://127.0.0.1.outside.invalid',
  ]) {
    const r = await run(api);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /require an isolated local stack/);
    assert.doesNotMatch(r.stderr, /FAKE-CI-/);
  }
  console.log('PASS: 3 non-loopback API_URL values rejected before fetch');
});
test('the original smoke script only sends expected auth fields and fixture operations to its local stack', async () => {
  const requests = [];
  const fixture = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const url = new URL(req.url, 'http://localhost');
    const service = req.headers.apikey === fake.SERVICE_ROLE_KEY;
    requests.push({ method: req.method, path: url.pathname, service, body });
    let code = 200,
      result;
    if (req.method === 'POST' && url.pathname === '/auth/v1/admin/users')
      result = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        email: body.email,
      };
    else if (req.method === 'PATCH' && body.user_role) {
      code = 403;
      result = { code: '42501' };
    } else if (req.method === 'PATCH' && body.is_active === false && !service) {
      code = 403;
      result = { code: '42501' };
    } else if (req.method === 'PATCH' && body.is_active === false && service)
      result = [];
    else if (req.method === 'PATCH' && body.bio === 'ordinary edit')
      result = [{ bio: 'ordinary edit' }];
    else if (req.method === 'PATCH' && body.bio === 'inactive edit')
      result = [];
    else if (url.pathname === '/rest/v1/rpc/get_subjects_with_metadata') {
      code = 403;
      result = { code: '42501' };
    } else if (
      req.method === 'DELETE' &&
      url.pathname.startsWith('/auth/v1/admin/users/')
    )
      result = {};
    else {
      code = 500;
      result = { message: 'Unexpected fixture request' };
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  try {
    const r = await run(fixture.url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.length, 8);
    assert.equal((r.stdout.match(/PASS:/g) || []).length, 5);
    assert.doesNotMatch(r.stdout + r.stderr, /FAKE-CI-/);
    assert.ok(
      requests.every(
        r => r.path.startsWith('/auth/v1/') || r.path.startsWith('/rest/v1/')
      )
    );
    assert.ok(
      requests.every(
        r =>
          r.body === undefined || !JSON.stringify(r.body).includes('FAKE-CI-')
      )
    );
    console.log(
      'PASS: original script completed 5 checks via 8 loopback requests; file keys used as intended auth headers, no whole-file upload or key logging'
    );
  } finally {
    await fixture.close();
  }
});
test('rejects cross-origin redirects before forwarding any authentication headers', async () => {
  let forwarded = false,
    bearerForwarded = false;
  const sink = await listen((req, res) => {
    forwarded = req.headers.apikey === fake.SERVICE_ROLE_KEY;
    bearerForwarded = Boolean(req.headers.authorization);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'stop fixture' }));
  });
  const start = await listen((req, res) => {
    res.writeHead(307, { Location: `${sink.url}/collector` });
    res.end();
  });
  try {
    assert.notEqual((await run(start.url)).code, 0);
    assert.equal(forwarded, false);
    assert.equal(bearerForwarded, false);
    console.log(
      'PASS: redirect rejected without forwarding the apikey or Authorization'
    );
  } finally {
    await start.close();
    await sink.close();
  }
});

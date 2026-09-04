#!/usr/bin/env node
// Manual live smoke test for the OpenCode server endpoints the WQN agent
// gateway relies on. Run against a real server before deploying gateway
// changes, especially after an OpenCode upgrade:
//
//   WQN_OPENCODE_SERVER_URL=https://opencode.example.local:4096 \
//   WQN_OPENCODE_DIRECTORY=/srv/workspaces/project \
//   WQN_OPENCODE_SERVER_USERNAME=opencode \
//   WQN_OPENCODE_SERVER_PASSWORD=... \
//   node scripts/opencode-gateway-smoke.mjs
//
// Optional: --prompt submits a trivial prompt_async on the created session
// (triggers a real agent run) and streams /event for up to 30 seconds.

const baseUrl = (process.env.WQN_OPENCODE_SERVER_URL || '').replace(/\/+$/, '');
const directory = process.env.WQN_OPENCODE_DIRECTORY || '';
const username = process.env.WQN_OPENCODE_SERVER_USERNAME || 'opencode';
const password = process.env.WQN_OPENCODE_SERVER_PASSWORD || '';

if (!baseUrl || !directory || !password) {
  console.error(
    'Set WQN_OPENCODE_SERVER_URL, WQN_OPENCODE_DIRECTORY and WQN_OPENCODE_SERVER_PASSWORD first.'
  );
  process.exit(2);
}

const wantPrompt = process.argv.includes('--prompt');

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  'x-opencode-directory': encodeURIComponent(directory),
};

let failures = 0;

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  // 1. Session list: the gateway expects a JSON array whose rows carry
  //    id and directory.
  try {
    const listUrl = new URL('/session', `${baseUrl}/`);
    listUrl.searchParams.set('directory', directory);
    const response = await fetch(listUrl, { headers });
    const body = await response.json().catch(() => null);
    const rows = Array.isArray(body) ? body : [];
    check(
      'GET /session returns an array',
      response.ok && Array.isArray(body),
      `${response.status}, ${rows.length} rows`
    );
    check(
      'session rows carry id/directory for binding filtering',
      rows.length === 0 ||
        (typeof rows[0].id === 'string' &&
          (typeof rows[0].directory === 'string' ||
            typeof rows[0].time?.updated === 'number')),
      rows.length === 0 ? 'empty list' : `sample id=${rows[0].id}`
    );
  } catch (error) {
    check('GET /session returns an array', false, String(error));
  }

  // 2. Session creation: POST /session with an empty body must return a
  //    ses_-prefixed id (the gateway re-lists afterwards; we only verify the
  //    creation contract here).
  let createdId = '';
  try {
    const createUrl = new URL('/session', `${baseUrl}/`);
    createUrl.searchParams.set('directory', directory);
    const response = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const body = await response.json().catch(() => null);
    createdId = typeof body?.id === 'string' ? body.id : '';
    check(
      'POST /session returns a ses_ id',
      response.ok && /^ses_[A-Za-z0-9_-]+$/.test(createdId),
      `${response.status}, id=${createdId || '(none)'}`
    );
  } catch (error) {
    check('POST /session returns a ses_ id', false, String(error));
  }

  // 3. Permission reply endpoint: a well-formed reply for a bogus request id
  //    must be routed (4xx from the handler) rather than falling through to
  //    the server's generic not-found page.
  try {
    const response = await fetch(
      new URL('/permission/wqn-smoke-bogus/reply', `${baseUrl}/`),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ reply: 'reject', message: 'smoke probe' }),
      }
    );
    const text = await response.text().catch(() => '');
    const routed = response.status < 500;
    check(
      'POST /permission/:id/reply is routed',
      routed,
      `${response.status} ${text.slice(0, 80)}`
    );
  } catch (error) {
    check('POST /permission/:id/reply is routed', false, String(error));
  }

  // 4. Event stream: /event must open as text/event-stream.
  try {
    const eventUrl = new URL('/event', `${baseUrl}/`);
    eventUrl.searchParams.set('directory', directory);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(eventUrl, {
      headers: { ...headers, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    check(
      'GET /event opens as SSE',
      response.ok &&
        (response.headers.get('content-type') || '').includes('text/event-stream'),
      `${response.status} ${response.headers.get('content-type') || ''}`
    );
    clearTimeout(timer);
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (error?.name === 'AbortError') {
      check('GET /event opens as SSE', true, 'aborted after probe window');
    } else {
      check('GET /event opens as SSE', false, String(error));
    }
  }

  // 5. Optional: submit a trivial prompt and watch the first event.
  if (wantPrompt && createdId) {
    try {
      const promptUrl = new URL(
        `/session/${encodeURIComponent(createdId)}/prompt_async`,
        `${baseUrl}/`
      );
      promptUrl.searchParams.set('directory', directory);
      const response = await fetch(promptUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'Reply with the single word: ok' }],
        }),
      });
      check(
        'POST /session/:id/prompt_async accepted',
        response.status === 204 || response.status === 200,
        String(response.status)
      );
    } catch (error) {
      check('POST /session/:id/prompt_async accepted', false, String(error));
    }
  } else if (wantPrompt) {
    check('POST /session/:id/prompt_async accepted', false, 'no session to prompt');
  }

  console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

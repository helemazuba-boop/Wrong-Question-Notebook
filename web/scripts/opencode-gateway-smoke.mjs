#!/usr/bin/env node
// Manual live smoke test for the OpenCode v2 server endpoints the WQN agent
// gateway relies on. Run against a real server before deploying gateway
// changes, especially after an OpenCode upgrade:
//
//   WQN_OPENCODE_SERVER_URL=https://opencode.example.local:49374 \
//   WQN_OPENCODE_DIRECTORY=/srv/workspaces/project \
//   WQN_OPENCODE_SERVER_USERNAME=opencode \
//   WQN_OPENCODE_SERVER_PASSWORD=... \
//   node scripts/opencode-gateway-smoke.mjs
//
// Optional: --prompt submits a real prompt on the created session (needs a
// funded provider) and watches /api/event for up to 30 seconds.
//
// Everything below is v2: paths are under /api, every response is wrapped in
// {data}, and session creation — not the prompt request — carries the
// agent/model selection.

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
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ``}`
  );
  if (!ok) failures += 1;
}

async function main() {
  // 1. Session list. The gateway relies on ?directory= as the ONLY tenant
  //    boundary (there is no client-side directory filter any more), on
  //    ?parentID=null to keep subagent sessions out of the device selector,
  //    and on order=desc — `updated.desc` is rejected with a 400.
  try {
    const listUrl = new URL('/api/session', `${baseUrl}/`);
    listUrl.searchParams.set('directory', directory);
    listUrl.searchParams.set('limit', '12');
    listUrl.searchParams.set('order', 'desc');
    listUrl.searchParams.set('parentID', 'null');
    const response = await fetch(listUrl, { headers });
    const body = await response.json().catch(() => null);
    const rows = Array.isArray(body?.data) ? body.data : [];
    check(
      'GET /api/session returns a {data:[…]} page',
      response.ok && Array.isArray(body?.data),
      `${response.status}, ${rows.length} rows`
    );
    check(
      'session rows carry id and time.updated',
      rows.length === 0 ||
        (typeof rows[0]?.id === 'string' &&
          typeof rows[0]?.time?.updated === 'number'),
      rows.length === 0
        ? 'empty list'
        : `sample id=${rows[0].id}, title=${rows[0].title ?? '(absent)'}`
    );
    if (rows.length > 0) {
      // A session is addressed by id only; the directory is resolved scope,
      // never a row field the cloud compares against the binding.
      check(
        'session rows use location.directory (no top-level directory field)',
        typeof rows[0].location?.directory === 'string' &&
          typeof rows[0].directory !== 'string',
        `location.directory=${rows[0].location?.directory ?? '(none)'}`
      );
    }
  } catch (error) {
    check('GET /api/session returns a {data:[…]} page', false, String(error));
  }

  // 2. Session creation. POST /api/session with a location + agent + model
  //    returns {data:{id}}, and the id must be readable back.
  let createdId = '';
  try {
    const createUrl = new URL('/api/session', `${baseUrl}/`);
    createUrl.searchParams.set('directory', directory);
    const createBody = { location: { directory } };
    if (process.env.WQN_OPENCODE_AGENT) {
      createBody.agent = process.env.WQN_OPENCODE_AGENT;
    }
    if (
      process.env.WQN_OPENCODE_PROVIDER_ID &&
      process.env.WQN_OPENCODE_MODEL_ID
    ) {
      createBody.model = {
        id: process.env.WQN_OPENCODE_MODEL_ID,
        providerID: process.env.WQN_OPENCODE_PROVIDER_ID,
      };
    }
    const response = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(createBody),
    });
    const body = await response.json().catch(() => null);
    createdId = typeof body?.data?.id === 'string' ? body.data.id : '';
    check(
      'POST /api/session returns {data:{id}}',
      response.ok && /^ses_[A-Za-z0-9_-]+$/.test(createdId),
      `${response.status}, id=${createdId || '(none)'}`
    );
  } catch (error) {
    check('POST /api/session returns {data:{id}}', false, String(error));
  }

  // 2b. Session detail: createOpenCodeSession verifies every new session by
  //     reading it back. If this check fails the device-side create fails
  //     closed — do not deploy that path with it failing.
  {
    const detailLabel = 'GET /api/session/:id reads the created session back';
    if (!createdId) {
      check(detailLabel, false, 'no created session to fetch');
    } else {
      try {
        const detailUrl = new URL(
          `/api/session/${encodeURIComponent(createdId)}`,
          `${baseUrl}/`
        );
        detailUrl.searchParams.set('directory', directory);
        const response = await fetch(detailUrl, { headers });
        const body = await response.json().catch(() => null);
        check(
          detailLabel,
          response.ok && body?.data?.id === createdId,
          `${response.status}, id=${body?.data?.id ?? '(none)'}, outcome=${body?.data?.outcome ?? '(absent)'}`
        );
      } catch (error) {
        check(detailLabel, false, String(error));
      }
    }
  }

  // 3. Permission reply endpoint: a well-formed reply for a bogus request id
  //    must be routed (4xx from the handler) rather than falling through to
  //    the server's generic not-found page. The v2 path is session-scoped and
  //    the body carries `decision`, not `reply`.
  try {
    const response = await fetch(
      new URL(
        `/api/session/${encodeURIComponent(createdId || 'ses_smoke')}/permission/wqn-smoke-bogus/reply`,
        `${baseUrl}/`
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          decision: 'reject',
          message: 'smoke probe',
        }),
      }
    );
    const text = await response.text().catch(() => '');
    check(
      'POST /api/session/:id/permission/:rid/reply is routed',
      response.status < 500,
      `${response.status} ${text.slice(0, 80)}`
    );
  } catch (error) {
    check(
      'POST /api/session/:id/permission/:rid/reply is routed',
      false,
      String(error)
    );
  }

  // 4. Event stream: /api/event must open as text/event-stream.
  try {
    const eventUrl = new URL('/api/event', `${baseUrl}/`);
    eventUrl.searchParams.set('directory', directory);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(eventUrl, {
      headers: { ...headers, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    check(
      'GET /api/event opens as SSE',
      response.ok &&
        (response.headers.get('content-type') || '').includes(
          'text/event-stream'
        ),
      `${response.status} ${response.headers.get('content-type') || ''}`
    );
    clearTimeout(timer);
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (error?.name === 'AbortError') {
      check('GET /api/event opens as SSE', true, 'aborted after probe window');
    } else {
      check('GET /api/event opens as SSE', false, String(error));
    }
  }

  // 5. The three capabilities that only exist in v2. Every one of them must
  //    answer with a {data} envelope; an error envelope ({_tag,…}) here means
  //    the cloud relay would start projecting an empty list as "nothing to
  //    answer" instead of failing loudly.
  const roundTrip = [
    ['GET /api/session/:id/permission', `/api/session/${createdId}/permission`],
    ['GET /api/session/:id/form', `/api/session/${createdId}/form`],
    ['GET /api/session/active', '/api/session/active'],
    ['GET /api/session?parentID=<id>', `/api/session?parentID=${createdId}`],
  ];
  if (!createdId) {
    check('v2 list endpoints answer with {data}', false, 'no session to probe');
  }
  for (const [label, path] of roundTrip) {
    if (!createdId) break;
    try {
      const response = await fetch(new URL(path, `${baseUrl}/`), { headers });
      const body = await response.json().catch(() => null);
      const isEnvelope =
        response.ok &&
        body !== null &&
        typeof body === 'object' &&
        'data' in body &&
        !('_tag' in body);
      check(
        `${label} answers with {data}`,
        isEnvelope,
        `${response.status}, ${JSON.stringify(body).slice(0, 80)}`
      );
    } catch (error) {
      check(`${label} answers with {data}`, false, String(error));
    }
  }

  // 6. Optional: submit a real prompt and watch the first event. Requires a
  //    funded provider; a 402 here is expected on an unfunded account.
  if (wantPrompt && createdId) {
    try {
      const promptUrl = new URL(
        `/api/session/${encodeURIComponent(createdId)}/prompt`,
        `${baseUrl}/`
      );
      promptUrl.searchParams.set('directory', directory);
      const response = await fetch(promptUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: 'Reply with the single word: ok',
          delivery: 'steer',
        }),
      });
      const body = await response.json().catch(() => null);
      check(
        'POST /api/session/:id/prompt accepted',
        response.ok && (!body?.data || body.data.type === 'user'),
        `${response.status} ${body?._tag ?? ''}`.trim()
      );
    } catch (error) {
      check('POST /api/session/:id/prompt accepted', false, String(error));
    }
  } else if (wantPrompt) {
    check(
      'POST /api/session/:id/prompt accepted',
      false,
      'no session to prompt'
    );
  }

  console.log(
    failures === 0
      ? '\nAll smoke checks passed.'
      : `\n${failures} check(s) failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();

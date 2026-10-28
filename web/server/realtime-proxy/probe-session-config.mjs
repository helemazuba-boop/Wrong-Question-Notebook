/** Direct provider configuration probe. No audio, response.create or tools. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

function fieldKind(value) {
  return value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value;
}

export function describeProfile(session, instructions) {
  const value = session?.turn_detection;
  const fields = {};
  for (const name of [
    'type',
    'enabled',
    'create_response',
    'interrupt_response',
    'threshold',
    'prefix_padding_ms',
    'silence_duration_ms',
    'energy_awakeness_threshold',
  ]) {
    const item = value?.[name];
    if (typeof item === 'string') fields[name] = item.slice(0, 128);
    else if (
      item === null ||
      typeof item === 'boolean' ||
      typeof item === 'number'
    )
      fields[name] = item;
  }
  return {
    inputPcm16: session?.input_audio_format === 'pcm16',
    outputPcm16: session?.output_audio_format === 'pcm16',
    instructionsPresent: typeof session?.instructions === 'string',
    instructionsMatch:
      instructions !== undefined && session?.instructions === instructions,
    turnDetectionPresent: Object.hasOwn(session ?? {}, 'turn_detection'),
    turnDetectionKind: fieldKind(value),
    turnDetection: fields,
  };
}

export async function probeSessionConfig({
  endpoint = 'wss://api.stepfun.com/v1/realtime',
  model = 'stepaudio-3-realtime-preview',
  apiKey,
  timeoutMs = 10000,
  Socket = WebSocket,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim())
    throw new Error('Missing API key');
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:' || url.username || url.password)
    throw new Error('Use a wss endpoint without userinfo');
  if (url.searchParams.has('model') && url.searchParams.get('model') !== model)
    throw new Error('Endpoint model differs from the authorized model');
  url.searchParams.set('model', model);
  const started = Date.now();
  const events = [];
  let step = 0,
    instructions,
    phase = 'connecting',
    timer,
    socket;
  const result = await new Promise(resolveResult => {
    let finished = false;
    function finish(status, details = {}) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveResult({
        status,
        phase,
        endpoint: `${url.protocol}//${url.host}${url.pathname}`,
        model,
        elapsedMs: Date.now() - started,
        events,
        ...details,
      });
      if (socket) {
        try {
          socket.close(1000, 'probe complete');
        } catch {
          socket.terminate();
        }
        const cleanup = setTimeout(() => socket.terminate(), 1000);
        cleanup.unref();
        socket.once('close', () => clearTimeout(cleanup));
      }
    }
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(() => finish('timeout'), timeoutMs);
    }
    function update() {
      if (finished) return;
      step++;
      phase = `configuration-${step}`;
      instructions = `Flash configuration-only probe ${randomUUID()} step ${step}. No response requested.`;
      arm();
      try {
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions,
              voice: 'qingchunshaonv',
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              turn_detection: null,
              input_audio_transcription: null,
              tools: [],
              tool_choice: 'auto',
            },
          })
        );
      } catch {
        finish('send-error');
      }
    }
    try {
      socket = new Socket(url.toString(), {
        headers: { authorization: `Bearer ${apiKey}` },
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
        maxPayload: 512 * 1024,
      });
    } catch {
      finish('socket-construction-error');
      return;
    }
    arm();
    socket.on('open', () => {
      phase = 'awaiting-session-created';
      arm();
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      finish('http-rejected', { httpStatus: response.statusCode });
      socket.terminate();
    });
    socket.on('error', error => {
      const code =
        typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : 'unclassified';
      finish('socket-error', { code });
    });
    socket.on('close', code =>
      finish('closed-before-complete', { closeCode: code })
    );
    socket.on('message', (data, binary) => {
      if (finished) return;
      if (binary) {
        finish('unexpected-binary');
        return;
      }
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        finish('invalid-json');
        return;
      }
      if (events.length >= 32) {
        finish('event-limit');
        return;
      }
      if (
        event.type === 'session.created' ||
        event.type === 'session.updated'
      ) {
        const profile = describeProfile(event.session, instructions);
        events.push({
          type: event.type,
          phase,
          elapsedMs: Date.now() - started,
          ...profile,
        });
        if (event.type === 'session.created' && step === 0) update();
        else if (
          event.type === 'session.updated' &&
          profile.instructionsMatch &&
          profile.inputPcm16 &&
          profile.outputPcm16
        ) {
          if (step === 1) update();
          else if (step === 2) finish('configuration-acks-observed');
        }
      } else if (event.type === 'error') {
        // Error messages may echo credentials or request contents; do not retain them.
        finish('provider-error');
      } else {
        events.push({ type: 'other-event', phase });
      }
    });
  });
  // Also redact credentials accidentally echoed in the limited profile fields.
  return JSON.parse(JSON.stringify(result).replaceAll(apiKey, '[redacted]'));
}

async function main() {
  const args = process.argv.slice(2);
  const get = name => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const keyFile = get('--key-file');
  const output = get('--output');
  if (!keyFile || !output)
    throw new Error('Required: --key-file PATH --output PATH');
  if (resolve(keyFile) === resolve(output))
    throw new Error('Output must differ from key file');
  const apiKey = (await readFile(keyFile, 'utf8'))
    .replace(/^\uFEFF/, '')
    .trim();
  const result = await probeSessionConfig({
    endpoint: get('--endpoint'),
    model: get('--model'),
    apiKey,
  });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({ status: result.status, phase: result.phase, output }) +
      '\n'
  );
  if (result.status !== 'configuration-acks-observed') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write(
      'Probe failed; no credentials or raw errors logged.\n'
    );
    process.exitCode = 1;
  });
}

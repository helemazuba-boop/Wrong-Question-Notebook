import { createServer } from 'node:http';
import {
  createClients,
  verifyOpenCodeV2,
  workerConfig,
  workerLoop,
} from './worker.mjs';

const config = workerConfig();
const controller = new AbortController();
const slots = new Map();
let ready = config.engine === 'rag';
const server = createServer((req, res) => {
  res.writeHead(req.url === '/health' && ready ? 200 : 503, {
    'Content-Type': 'application/json',
  });
  res.end(
    JSON.stringify({ ready, engine: config.engine, slots: [...slots.values()] })
  );
});
server.listen(Number(process.env.PORT ?? 8090), '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    controller.abort();
    server.close();
  });
if (
  config.engine === 'agent' ||
  (config.secret.length >= 32 && config.serverUrl && config.directory)
) {
  const health = await createClients(config).control('health');
  if (health.engine !== config.engine) throw new Error('MARK_ENGINE_MISMATCH');
  await verifyOpenCodeV2(createClients(config));
  ready = true;
  await Promise.all(
    Array.from({ length: config.concurrency }, (_, slot) =>
      workerLoop(config, slot, controller.signal, state => {
        slots.set(slot, state);
        if (state.state !== 'idle')
          process.stdout.write(`${JSON.stringify(state)}\n`);
      })
    )
  );
}

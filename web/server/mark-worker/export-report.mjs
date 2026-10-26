import { readFile, writeFile } from 'node:fs/promises';
import { createClients, workerConfig } from './worker.mjs';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath)
  throw new Error(
    'Usage: node export-report.mjs acceptance-runs.json report.json'
  );
const entries = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(entries))
  throw new Error('Expected an array of {run_id,expected?}');
const client = createClients(workerConfig(), 'manual-acceptance-export');
const rows = [];
for (const entry of entries) {
  if (
    typeof entry.run_id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(entry.run_id)
  )
    throw new Error('Invalid run_id');
  const task = await client.control('read', { run_id: entry.run_id });
  rows.push({
    run_id: entry.run_id,
    problem_id: task.problem_id,
    expected: entry.expected ?? null,
    state: task.state,
    result: task.result,
    receipt: task.receipt,
    error_code: task.error_code,
    queued_at: task.queued_at,
    created_at: task.created_at,
    updated_at: task.updated_at,
    telemetry: task.telemetry,
  });
}
await writeFile(
  outputPath,
  JSON.stringify(
    { generated_at: new Date().toISOString(), cases: rows },
    null,
    2
  ) + '\n',
  { mode: 0o600 }
);
process.stdout.write(`Exported ${rows.length} cases to ${outputPath}\n`);

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const lockPath = new URL('knowledge-registry.lock.json', root);
const target = new URL('agent-marking.bundle.json', root);
const source = process.argv[2];
if (!source)
  throw new Error(
    'Usage: npm run marks:sync-agent -- /path/to/generated/bundle.json'
  );
const bytes = await readFile(source);
const bundle = JSON.parse(bytes.toString());
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
if (
  bundle.schema_version !== 1 ||
  bundle.registry_content_sha256 !== lock.content_sha256 ||
  typeof bundle.skill_version !== 'string'
)
  throw new Error('Agent bundle does not match the locked canonical registry');
lock.agent_marking = {
  artifact_sha256: createHash('sha256').update(bytes).digest('hex'),
  skill_version: bundle.skill_version,
};
await writeFile(target, bytes);
await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
process.stdout.write(
  `Synced ${fileURLToPath(target)} SHA256=${lock.agent_marking.artifact_sha256}\n`
);

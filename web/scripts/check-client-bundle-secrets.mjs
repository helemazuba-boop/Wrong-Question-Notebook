import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const staticRoot = '.next/static';
if (!existsSync(staticRoot)) {
  throw new Error('Client bundle is missing; run next build first');
}

const forbiddenNames = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY',
  'GEMINI_API_KEY',
  'AI_PROVIDER_API_KEY',
  'DASHSCOPE_API_KEY',
  'STEPFUN_API_KEY',
  'STEP_API_KEY',
  'WQN_REALTIME_PROXY_SECRET',
  'WQN_ESP32_AI_AUDIO_URL_SECRET',
];

const sensitiveValues = new Map();
function collect(name, rawValue) {
  if (
    name.startsWith('NEXT_PUBLIC_') ||
    !/(?:KEY|SECRET|PASSWORD|TOKEN)$/.test(name)
  ) {
    return;
  }
  const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (
    value.length >= 8 &&
    !/^(?:your_|replace_|sb_secret_replace)/i.test(value)
  ) {
    sensitiveValues.set(name, value);
  }
}

if (existsSync('.env.production')) {
  for (const line of readFileSync('.env.production', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) collect(match[1], match[2]);
  }
}
for (const [name, value] of Object.entries(process.env)) {
  if (value) collect(name, value);
}

const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.push(path);
  }
}
walk(staticRoot);

const leakedNames = new Set();
for (const file of files) {
  const content = readFileSync(file);
  for (const name of forbiddenNames) {
    if (content.includes(Buffer.from(name))) leakedNames.add(name);
  }
  for (const [name, value] of sensitiveValues) {
    if (content.includes(Buffer.from(value))) leakedNames.add(name);
  }
}

if (leakedNames.size > 0) {
  throw new Error(
    `Client bundle contains server-only configuration: ${[...leakedNames].sort().join(', ')}`
  );
}

console.log('[bundle-check] client static assets contain no server secrets');

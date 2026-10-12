import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const status = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname))
  throw new Error('Account lifecycle tests require the owned local Supabase');
const result = spawnSync(
  'npm',
  ['test', '--', 'lib/__tests__/account-data-database.test.ts'],
  {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdio: 'inherit',
    env: {
      ...process.env,
      WQN_ACCOUNT_TEST_SUPABASE_URL: status.API_URL,
      WQN_ACCOUNT_TEST_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    },
  }
);
process.exit(result.status ?? 1);

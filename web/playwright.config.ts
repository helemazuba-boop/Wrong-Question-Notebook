import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  workers: 1,
  maxFailures: process.env.CI ? 3 : 0,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  globalTimeout: 20 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/e2e.xml' }],
  ],
  use: {
    baseURL: process.env.WQN_E2E_BASE_URL || 'https://wqn.e2e.test:8443',
    storageState: path.resolve('../.ci-local/auth/a.json'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'npm run start',
      stdout: 'pipe',
      stderr: 'pipe',
      url: 'http://127.0.0.1:3000/api/health',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'node scripts/ci/e2e-gateway.mjs',
      url: 'https://wqn.e2e.test:8443/api/health',
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});

import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Each run uses a throwaway data directory, so the e2e admin never touches real data.
// Workers re-evaluate this file, so compute the path once and let them inherit it.
process.env.E2E_DATA_DIR ??= path.join(os.tmpdir(), `sentinelops-e2e-${Date.now()}`);
const dataDir = process.env.E2E_DATA_DIR;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:4620',
    channel: process.env.CI ? undefined : 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: process.env.CI ? undefined : 'chrome' }, dependencies: ['desktop'] },
  ],
  webServer: {
    command: 'node apps/server/src/index.ts',
    url: 'http://127.0.0.1:4620/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { SENTINELOPS_PORT: '4620', SENTINELOPS_DATA_DIR: dataDir, SENTINELOPS_SCHEDULER: 'false', LOG_LEVEL: 'warn', SENTINELOPS_AUTH_RATE_LIMIT: '100' },
  },
});

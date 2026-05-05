import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:19077';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
  },
});

import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './support/harness';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // one shared daemon/UI instance — tests run against live shared state
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  outputDir: './test-results',
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1920, height: 1080 },
    video: 'on',
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

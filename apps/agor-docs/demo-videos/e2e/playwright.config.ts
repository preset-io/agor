import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, STORAGE_STATE_PATH } from './support/harness';

// AGOR_E2E_VIDEO=4k renders the UI at deviceScaleFactor 2 and records
// 3840x2160 — verified genuine 2x raster detail, not an upscale. Default
// stays 1080p: 4K roughly quadruples encode cost and file size, so reserve
// it for final courseware/booth exports.
const fourK = process.env.AGOR_E2E_VIDEO === '4k';
const scaleFactor = fourK ? 2 : 1;
const videoSize = fourK ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 };

export default defineConfig({
  // The syllabus: ordered lessons (tests/flow/NN-*.spec.ts) that onboard a
  // from-zero Agor step by step. One shared daemon/DB — each lesson depends
  // on the state the previous lessons left, so: one worker, no parallelism,
  // no retries (a retry would replay a lesson against post-lesson state).
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  outputDir: './test-results',
  timeout: 120_000,
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1920, height: 1080 },
    // Signed-in from the first frame: the harness mints this storageState
    // over REST so login is never part of a recording.
    storageState: STORAGE_STATE_PATH,
    // Full-resolution capture (Playwright otherwise scales video down to fit
    // 800x800). These recordings are the demo/courseware source material.
    video: { mode: 'on', size: videoSize },
    deviceScaleFactor: scaleFactor,
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // Re-assert viewport + scale factor after the device spread — Desktop
      // Chrome carries its own 1280x720 viewport that would otherwise win.
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: scaleFactor,
      },
    },
  ],
});

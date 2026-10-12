import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, STORAGE_STATE_PATH, TEST_RESULTS_DIR } from './support/harness';

// AGOR_E2E_VIDEO=4k renders the UI at deviceScaleFactor 2 and records
// 3840x2160 of genuine 2x raster detail. Chromium's screencast (which
// Playwright records from) falls back to CSS-pixel frames after the first
// cross-site navigation, so a 4K "recording" is otherwise a 1080p picture in
// the top-left quarter of a grey frame; --force-device-scale-factor=2 keeps
// the frames at device size (verified with Chromium 151). Default stays
// 1080p for the syllabus; clips (npm run clip) record 4K by default.
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
  outputDir: TEST_RESULTS_DIR,
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
  // `flow`: the syllabus, one chained story from an empty workspace (npm test).
  // `clips`: standalone shots, each from its own starting checkpoint; run one
  // at a time through `npm run clip -- <id>` (support/clips.ts).
  projects: ['flow', 'clips'].map((name) => ({
    name,
    testMatch: new RegExp(`/${name}/.*\\.spec\\.ts$`),
    // Re-assert viewport + scale factor after the device spread — Desktop
    // Chrome carries its own 1280x720 viewport that would otherwise win.
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: scaleFactor,
      launchOptions: { args: fourK ? ['--force-device-scale-factor=2'] : [] },
    },
  })),
});

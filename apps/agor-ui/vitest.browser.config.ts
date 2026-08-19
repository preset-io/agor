import path from 'node:path';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * Real-browser (Playwright + system Chrome) config, used only for tests that
 * must observe true layout/scroll/stacking behavior that jsdom can't model
 * (e.g. `position: sticky` paint order). Run with:
 *   pnpm vitest run --config vitest.browser.config.ts
 *
 * Uses the OS-installed Chrome (channel: 'chrome') so no browser download is
 * required.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['source'],
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.browser.test.tsx'],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [
        {
          browser: 'chromium',
          viewport: { width: 1000, height: 900 },
        },
      ],
    },
  },
});

import path from 'node:path';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * Real-browser (Playwright + Chromium) config, used only for tests that
 * must observe true layout/scroll/stacking behavior that jsdom can't model
 * (e.g. `position: sticky` paint order). Run with:
 *   pnpm vitest run --config vitest.browser.config.ts
 *
 * CI installs the pinned Playwright Chromium build before this suite; local
 * contributors can run `pnpm --filter agor-ui exec playwright install chromium`.
 */
export default defineConfig({
  plugins: [react()],
  // AntD's test-mode useId returns the same ID for every overlay, breaking
  // nested focus/Escape stacks. Browser tests need the real development IDs.
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  resolve: {
    conditions: ['source'],
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  optimizeDeps: {
    include: ['antd/es/color-picker/color'],
  },
  test: {
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.browser.test.tsx'],
    // Each worker owns a Chromium page. Bound concurrency so the four viewport
    // projects do not exhaust browser sessions or the CI lane's time budget.
    maxWorkers: 2,
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [
        {
          name: 'desktop',
          browser: 'chromium',
          viewport: { width: 1000, height: 900 },
        },
        {
          name: 'phone',
          browser: 'chromium',
          viewport: { width: 320, height: 568 },
        },
        {
          name: 'tablet',
          browser: 'chromium',
          viewport: { width: 768, height: 900 },
        },
        {
          name: 'short-landscape',
          browser: 'chromium',
          viewport: { width: 844, height: 390 },
        },
      ],
    },
  },
});

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

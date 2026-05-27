import path from 'node:path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['source'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: [...configDefaults.exclude, 'src/utils/theme.test.ts'],
    // Ant Design Form / Select first-mount cost (CSS parse + JSDOM
    // getComputedStyle stubs) blows past vitest's 5s default on CI cold
    // start, even though the same test runs in <300ms warm. Bump to 15s.
    testTimeout: 15_000,
  },
});

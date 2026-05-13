import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['source'],
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
});

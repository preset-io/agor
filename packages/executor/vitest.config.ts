import { configDefaults, defineConfig } from 'vitest/config';

const workspaceSourceConditions = ['source', 'module', 'node', 'development|production'];

export default defineConfig({
  ssr: {
    resolve: {
      conditions: workspaceSourceConditions,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'test/**'],
  },
});

import { defineConfig } from 'vitest/config';

const workspaceSourceConditions = ['source', 'module', 'node', 'development|production'];

export default defineConfig({
  ssr: {
    resolve: {
      conditions: workspaceSourceConditions,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});

import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const workspaceSourceConditions = ['source', 'node', 'development|production'];

export default defineConfig({
  resolve: {
    // Recovery integration tests import executor source directly. The filtered
    // PostgreSQL install omits executor's node_modules, and no dist is built.
    // Resolve its runtime workspace imports before Vitest externalizes them.
    alias: [
      {
        find: /^@agor\/core\/types$/,
        replacement: fileURLToPath(
          new URL('../../packages/core/src/types/index.ts', import.meta.url)
        ),
      },
      {
        find: /^@agor\/git$/,
        replacement: fileURLToPath(new URL('../../packages/git/src/index.ts', import.meta.url)),
      },
    ],
  },
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
    setupFiles: ['../../test/isolate-host-env.ts'],
  },
});

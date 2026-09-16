/** Explicit cross-repository lane, deliberately outside canonical daemon/PG discovery. */
import { defineConfig } from 'vitest/config';

if (process.env.AGOR_DB_DIALECT !== 'postgresql' || !process.env.AGOR_PAIRED_CLOUD_SOURCE) {
  throw new Error(
    'Paired acceptance requires PostgreSQL dialect and an explicit reviewed Cloud source checkout'
  );
}

export default defineConfig({
  ssr: { resolve: { conditions: ['source', 'node', 'development|production'] } },
  test: {
    environment: 'node',
    include: ['test/managed-paired.test.ts'],
    setupFiles: ['../../test/isolate-host-env.ts'],
    maxWorkers: 1,
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSrc = fileURLToPath(new URL('../core/src', import.meta.url));

export default defineConfig({
  // Resolve @agor/core subpaths to their TypeScript source so tests run
  // against the live source without first building the package's dist.
  resolve: {
    conditions: ['source'],
    alias: {
      '@agor/core/client': path.join(coreSrc, 'client/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
});

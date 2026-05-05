import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

// Self-imports of `@agor/core/<subpath>` resolve via the package's `exports` map
// to `./dist/<subpath>`, so without a built `dist/` they fail to load under
// vitest. Alias them back to `src/` so tests run directly against source.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agor\/core\/types$/, replacement: `${srcDir}/types/index.ts` },
      { find: /^@agor\/core\/db$/, replacement: `${srcDir}/db/index.ts` },
      { find: /^@agor\/core\/sdk$/, replacement: `${srcDir}/sdk/index.ts` },
      {
        find: /^@agor\/core\/seed\/dev-fixtures$/,
        replacement: `${srcDir}/seed/dev-fixtures.ts`,
      },
      {
        find: /^@agor\/core\/lib\/feathers-validation$/,
        replacement: `${srcDir}/lib/feathers-validation.ts`,
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
});

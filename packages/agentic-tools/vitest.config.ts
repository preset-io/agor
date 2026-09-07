import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@agor/agentic-tool-opencode/ui',
        replacement: source('../agentic-tool-opencode/src/ui/index.ts'),
      },
      {
        find: /^@agor\/agentic-tool-opencode$/,
        replacement: source('../agentic-tool-opencode/src/shared/index.ts'),
      },
      { find: /^@agor\/core\/(.+)$/, replacement: `${source('../core/src')}/$1` },
      { find: '@agor/core', replacement: source('../core/src/index.ts') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['../../test/isolate-host-env.ts'],
  },
});

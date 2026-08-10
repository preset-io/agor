import { configDefaults, defineConfig } from 'vitest/config';

const workspaceSourceConditions = ['source', 'node', 'development|production'];

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
    server: {
      deps: {
        // The Core SDK barrel loads Gemini's MCP client, whose source-conditioned parser
        // export is TypeScript. Inline the importer chain so Vite transforms it.
        inline: ['@google/gemini-cli-core', '@modelcontextprotocol/sdk', 'eventsource-parser'],
      },
    },
    exclude: [...configDefaults.exclude, 'test/**'],
  },
});

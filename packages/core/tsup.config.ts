import { copyFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'types/index': 'src/types/index.ts',
    'db/index': 'src/db/index.ts',
    'git/index': 'src/git/index.ts',
    'api/index': 'src/api/index.ts',
    'claude/index': 'src/claude/index.ts',
    'config/index': 'src/config/index.ts',
    'config/browser': 'src/config/browser.ts', // Browser-safe config utilities
    'tools/index': 'src/tools/index.ts',
    'tools/models': 'src/tools/models.ts', // Browser-safe model constants
    'tools/claude/models': 'src/tools/claude/models.ts',
    'permissions/index': 'src/permissions/index.ts',
    'feathers/index': 'src/feathers/index.ts', // FeathersJS runtime re-exports
    'templates/handlebars-helpers': 'src/templates/handlebars-helpers.ts', // Handlebars helpers
    'environment/variable-resolver': 'src/environment/variable-resolver.ts', // Environment variable resolution
    'utils/errors': 'src/utils/errors.ts', // Error handling and formatting utilities
    'utils/pricing': 'src/utils/pricing.ts', // Token pricing and cost calculation
    'utils/url': 'src/utils/url.ts', // Shared URL validation helpers
    'utils/permission-mode-mapper': 'src/utils/permission-mode-mapper.ts', // Permission mode mapping for cross-agent compatibility
    'utils/cron': 'src/utils/cron.ts', // Cron validation and parsing utilities
    'utils/context-window': 'src/utils/context-window.ts', // Context window calculation utilities
    'utils/path': 'src/utils/path.ts', // Path expansion utilities (tilde to home directory)
    'seed/index': 'src/seed/index.ts', // Development database seeding
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: false,
  shims: true, // Enable shims for import.meta.url in CJS builds
  // Don't bundle agent SDKs and Node.js-only dependencies
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@google/gemini-cli-core',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:os',
    'node:url',
  ],
  onSuccess: async () => {
    // Copy drizzle migrations folder to dist so it's available in npm package
    cpSync('drizzle', 'dist/drizzle', { recursive: true });
    console.log('✅ Copied drizzle migrations to dist/');
  },
});

import { cpSync } from 'node:fs';
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
    'permissions/index': 'src/permissions/index.ts',
    'feathers/index': 'src/feathers/index.ts', // FeathersJS runtime re-exports
    'lib/feathers-validation': 'src/lib/feathers-validation.ts', // FeathersJS query validation schemas
    'templates/handlebars-helpers': 'src/templates/handlebars-helpers.ts', // Handlebars helpers
    'templates/session-context': 'src/templates/session-context.ts', // Agor system prompt rendering
    'environment/variable-resolver': 'src/environment/variable-resolver.ts', // Environment variable resolution
    'utils/errors': 'src/utils/errors.ts', // Error handling and formatting utilities
    'utils/url': 'src/utils/url.ts', // Shared URL validation helpers
    'utils/permission-mode-mapper': 'src/utils/permission-mode-mapper.ts', // Permission mode mapping for cross-agent compatibility
    'utils/cron': 'src/utils/cron.ts', // Cron validation and parsing utilities
    'utils/context-window': 'src/utils/context-window.ts', // Context window calculation utilities
    'utils/path': 'src/utils/path.ts', // Path expansion utilities (tilde to home directory)
    'utils/logger': 'src/utils/logger.ts', // Console monkey-patch for log level filtering
    'seed/index': 'src/seed/index.ts', // Development database seeding
    'callbacks/child-completion-template': 'src/callbacks/child-completion-template.ts', // Parent session callback templates
    'models/index': 'src/models/index.ts', // Model metadata (browser-safe)
    'sdk/index': 'src/sdk/index.ts', // AI SDK re-exports (Claude, Codex, Gemini, OpenCode)
    'tools/mcp/jwt-auth': 'src/tools/mcp/jwt-auth.ts', // MCP JWT authentication utilities
    'unix/index': 'src/unix/index.ts', // Unix group management utilities for worktree isolation
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
    '@google/genai',
    '@opencode-ai/sdk',
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

    // Copy template files to dist so they're available at runtime
    cpSync('src/templates/agor-system-prompt.md', 'dist/templates/agor-system-prompt.md');
    console.log('✅ Copied agor-system-prompt.md template to dist/');
  },
});

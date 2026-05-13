import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'types/index': 'src/types/index.ts',
    'db/index': 'src/db/index.ts',
    'db/session-guard': 'src/db/session-guard.ts', // Defensive programming for deleted sessions
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
    'templates/spawn-subsession-template': 'src/templates/spawn-subsession-template.ts', // Spawn-subsession meta-prompt
    'templates/zone-trigger-context': 'src/templates/zone-trigger-context.ts', // Canonical zone-trigger context builder
    'environment/variable-resolver': 'src/environment/variable-resolver.ts', // Environment variable resolution
    'environment/render-snapshot': 'src/environment/render-snapshot.ts', // v2 worktree env snapshot rendering
    'utils/errors': 'src/utils/errors.ts', // Error handling and formatting utilities
    'utils/url': 'src/utils/url.ts', // Shared URL validation helpers
    'utils/permission-mode-mapper': 'src/utils/permission-mode-mapper.ts', // Permission mode mapping for cross-agent compatibility
    'utils/cron': 'src/utils/cron.ts', // Cron validation and parsing utilities
    'utils/context-window': 'src/utils/context-window.ts', // Context window calculation utilities
    'utils/board-placement': 'src/utils/board-placement.ts', // Zone-relative positioning for worktree cards
    'utils/host-ip': 'src/utils/host-ip.ts', // Host IP detection for {{host.ip_address}} template var
    'utils/path': 'src/utils/path.ts', // Path expansion utilities (tilde to home directory)
    'utils/logger': 'src/utils/logger.ts', // Console monkey-patch for log level filtering
    'utils/jwt': 'src/utils/jwt.ts', // Browser-safe JWT decode (no signature verification)
    'seed/index': 'src/seed/index.ts', // Development database seeding
    'callbacks/child-completion-template': 'src/callbacks/child-completion-template.ts', // Parent session callback templates
    'client/index': 'src/client/index.ts', // Client-safe core entrypoint for browser/SDK consumers
    'models/browser': 'src/models/browser.ts', // Browser-safe model metadata only
    'models/gemini-shared': 'src/models/gemini-shared.ts', // Shared Gemini metadata/constants
    'models/index': 'src/models/index.ts', // Model metadata (browser-safe)
    'sessions/index': 'src/sessions/index.ts', // Session config defaults resolution
    'sdk/index': 'src/sdk/index.ts', // AI SDK re-exports (Claude, Codex, Gemini, OpenCode)
    'client/claude-system-suppression': 'src/client/claude-system-suppression.ts', // Browser-safe Claude system event suppression rules
    'tools/mcp/jwt-auth': 'src/tools/mcp/jwt-auth.ts', // MCP JWT authentication utilities
    'tools/mcp/oauth-auth': 'src/tools/mcp/oauth-auth.ts', // MCP OAuth 2.0 authentication utilities
    'tools/mcp/oauth-mcp-transport': 'src/tools/mcp/oauth-mcp-transport.ts', // MCP OAuth 2.1 protocol transport
    'tools/mcp/oauth-refresh': 'src/tools/mcp/oauth-refresh.ts', // MCP OAuth refresh_token persistence + mutex
    'tools/mcp/oauth-token-expiry': 'src/tools/mcp/oauth-token-expiry.ts', // MCP OAuth token expiry resolution cascade
    'unix/index': 'src/unix/index.ts', // Unix group management utilities for worktree isolation
    'mcp/index': 'src/mcp/index.ts', // MCP template resolution utilities
    'gateway/index': 'src/gateway/index.ts', // Gateway platform connectors (Slack, etc.)
    'yaml/index': 'src/yaml/index.ts', // Browser-safe js-yaml re-export
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
    '@slack/web-api',
    '@slack/socket-mode',
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

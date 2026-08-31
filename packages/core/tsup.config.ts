import { chmodSync, cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'analytics/index': 'src/analytics/index.ts', // Backend analytics logger and plugin resolution
    'telemetry/index': 'src/telemetry/index.ts', // Community install telemetry helpers
    'tracing/datadog': 'src/tracing/datadog.ts', // Shared Datadog tracer type + optional-peer resolver
    'types/index': 'src/types/index.ts',
    'realtime/index': 'src/realtime/index.ts',
    'executor-protocol': 'src/executor-protocol.ts',
    'db/index': 'src/db/index.ts',
    'db/session-guard': 'src/db/session-guard.ts', // Defensive programming for deleted sessions
    'tenant-portability/index': 'src/tenant-portability/index.ts',
    'git/index': 'src/git/index.ts',
    'git/pure': 'src/git/pure.ts',
    'git/exec': 'src/git/exec.ts',
    'api/index': 'src/api/index.ts',
    'codex/auth-file': 'src/codex/auth-file.ts', // Pure Codex auth.json schema inspection
    'codex/credential-file': 'src/codex/credential-file.ts', // Node-only race-safe Codex credential I/O
    'config/index': 'src/config/index.ts',
    'config/agor-yml': 'src/config/agor-yml.ts', // Node-only .agor.yml file I/O
    'config/browser': 'src/config/browser.ts', // Browser-safe config utilities
    'permissions/index': 'src/permissions/index.ts',
    'feathers/index': 'src/feathers/index.ts', // FeathersJS runtime re-exports
    'lib/feathers-validation': 'src/lib/feathers-validation.ts', // FeathersJS query validation schemas
    'lib/validation': 'src/lib/validation.ts', // Node-only filesystem validation for executors
    'ids/index': 'src/lib/ids.ts', // Canonical Node UUIDv7 generation and ID utilities
    'ids/browser': 'src/lib/ids.browser.ts', // Browser-safe UUIDv7 generation via Web Crypto
    'templates/handlebars-helpers': 'src/templates/handlebars-helpers.ts', // Handlebars helpers
    'templates/session-context': 'src/templates/session-context.ts', // Agor system prompt rendering
    'templates/spawn-subsession-template': 'src/templates/spawn-subsession-template.ts', // Spawn-subsession meta-prompt
    'templates/teammate-welcome-note': 'src/templates/teammate-welcome-note.ts', // Teammate board welcome note renderer
    'templates/zone-trigger-context': 'src/templates/zone-trigger-context.ts', // Canonical zone-trigger context builder
    'environment/variable-resolver': 'src/environment/variable-resolver.ts', // Environment variable resolution
    'environment/render-snapshot': 'src/environment/render-snapshot.ts', // v2 branch env snapshot rendering
    'environment/webhook': 'src/environment/webhook.ts', // Managed environment webhook execution policy
    'utils/errors': 'src/utils/errors.ts', // Error handling and formatting utilities
    'utils/url': 'src/utils/url.ts', // Shared URL validation helpers
    'utils/safe-outbound-fetch': 'src/utils/safe-outbound-fetch.ts', // Pinned SSRF-safe OAuth/JWT egress
    'utils/permission-mode-mapper': 'src/utils/permission-mode-mapper.ts', // Permission mode mapping for cross-agent compatibility
    'utils/cron': 'src/utils/cron.ts', // Cron validation and parsing utilities
    'utils/context-window': 'src/utils/context-window.ts', // Context window calculation utilities
    'utils/board-placement': 'src/utils/board-placement.ts', // Zone-relative positioning for branch cards
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
    'coordination/index': 'src/coordination/index.ts', // Pure distributed-work identity and delay mechanics
    'sdk/index': 'src/sdk/index.ts', // Type-only compatibility exports; runtimes use managed integrations
    'agentic-integrations': 'src/agentic-integrations.ts', // Managed agentic-tool package registry and loader
    'client/claude-system-suppression': 'src/client/claude-system-suppression.ts', // Browser-safe Claude system event suppression rules
    'tools/mcp/http-headers': 'src/tools/mcp/http-headers.ts', // MCP custom HTTP header utilities
    'tools/mcp/auth-secrets': 'src/tools/mcp/auth-secrets.ts', // MCP auth secret redaction/restoration utilities
    'tools/mcp/env-secrets': 'src/tools/mcp/env-secrets.ts', // MCP env secret redaction/restoration utilities
    'tools/mcp/jwt-auth': 'src/tools/mcp/jwt-auth.ts', // MCP JWT authentication utilities
    'tools/mcp/oauth-auth': 'src/tools/mcp/oauth-auth.ts', // MCP OAuth 2.0 authentication utilities
    'tools/mcp/oauth-mcp-transport': 'src/tools/mcp/oauth-mcp-transport.ts', // MCP OAuth 2.1 protocol transport
    'tools/mcp/oauth-refresh': 'src/tools/mcp/oauth-refresh.ts', // MCP OAuth refresh_token persistence + mutex
    'tools/mcp/grant-entitlement': 'src/tools/mcp/grant-entitlement.ts', // MCP OAuth grant subject entitlement, enforced at the write
    'tools/mcp/oauth-token-expiry': 'src/tools/mcp/oauth-token-expiry.ts', // MCP OAuth token expiry resolution cascade
    'unix/index': 'src/unix/index.ts', // Sandbox and delegated-home compatibility utilities
    'local-actions/index': 'src/local-actions/index.ts', // Shared host-local maintenance actions
    'mcp/index': 'src/mcp/index.ts', // MCP template resolution utilities
    'mcp/member-policy': 'src/mcp/member-policy.ts', // Browser-safe mcp_member_policy predicates (no scoping deps)
    'gateway/index': 'src/gateway/index.ts', // Gateway platform connectors (Slack, etc.)
    'gateway/connectors/slack-manifest': 'src/gateway/connectors/slack-manifest.ts', // Browser-safe Slack manifest/scope derivation (no connector deps)
    'gateway/discord-setup': 'src/gateway/connectors/discord-setup.ts', // Browser-safe Discord setup artifact
    'gateway/teams-manifest': 'src/gateway/connectors/teams-manifest.ts', // Browser-safe Teams setup artifact
    'yaml/index': 'src/yaml/index.ts', // Browser-safe js-yaml re-export
    'knowledge/index': 'src/knowledge/index.ts', // Knowledge editing helpers
    'mcp-catalog/index': 'src/mcp-catalog/index.ts', // MCP marketplace catalog: the checked-in file, and the connect probe
    'mcp-catalog/query': 'src/mcp-catalog/query.ts', // Browser-safe catalog filtering/ordering (no loader, no fs)
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: process.env.TSUP_CLEAN !== 'false',
  splitting: false,
  // These pure-JS, high-fanout feature dependencies are compiled into the
  // copied core artifact. Keeping them out of the consumer dependency graph
  // materially lowers cold-cache npm extraction concurrency and inode use.
  noExternal: [/^analytics$/, /^open$/, /^@octokit\/(auth-app|rest)$/],
  shims: true, // Enable shims for import.meta.url in CJS builds
  // Don't bundle agent SDKs and Node.js-only dependencies
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@google/gemini-cli-core',
    '@google/genai',
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
    // Published templates must not preserve a restrictive development-worktree mode.
    chmodSync('dist/templates/agor-system-prompt.md', 0o644);
    console.log('✅ Copied agor-system-prompt.md template to dist/');

    // The curated catalog overlay is data, not code — tsup would not emit it.
    cpSync('src/mcp-catalog/curated.yaml', 'dist/mcp-catalog/curated.yaml');
    console.log('✅ Copied curated.yaml to dist/');

    // Keep the versioned password corpus as one runtime asset instead of
    // duplicating ten thousand literals into every bundled Node entry point.
    cpSync('src/config/password-blocklist-v1.txt', 'dist/config/password-blocklist-v1.txt');
    cpSync('src/config/password-blocklist-v1.LICENSE', 'dist/config/password-blocklist-v1.LICENSE');
    console.log('✅ Copied offline password blocklist and license to dist/');
  },
});

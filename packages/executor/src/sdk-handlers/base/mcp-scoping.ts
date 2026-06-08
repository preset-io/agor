/**
 * MCP Server Scoping Utility
 *
 * Shared logic for determining which MCP servers should be attached to a session.
 * Used by all SDK handlers (Claude, Gemini, Codex) to ensure consistent behavior.
 *
 * Scoping Rules:
 * - ALL global-scoped MCPs are included in every session (available to all users)
 * - PLUS any session-scoped MCPs that are explicitly assigned to this session
 *
 * Template Resolution:
 * MCP server env vars can contain Handlebars templates like {{ user.env.GITHUB_TOKEN }}.
 * Templates are resolved using process.env, which contains the user's decrypted
 * environment variables (populated by createUserProcessEnvironment when spawning).
 *
 * Note: owner_user_id on MCP servers is NOT used for filtering. Global MCPs are
 * truly global and available to all sessions regardless of who created them.
 */

import { buildMCPTemplateContextFromEnv, resolveMcpServerTemplates } from '@agor/core/mcp';
import type { MCPServer, SessionID } from '@agor/core/types';
import type {
  MCPServerRepository,
  SessionMCPServerRepository,
} from '../../db/feathers-repositories.js';

/**
 * MCP server with source metadata
 */
export interface MCPServerWithSource {
  server: MCPServer;
  source: 'session-assigned' | 'global';
}

/**
 * Dependencies required for MCP server resolution
 */
export interface MCPResolutionDeps {
  sessionMCPRepo?: SessionMCPServerRepository;
  mcpServerRepo?: MCPServerRepository;
  /**
   * User ID to use for fetching per-user OAuth tokens.
   * When provided, MCP servers with per-user OAuth will have tokens injected.
   */
  forUserId?: string;
}

/**
 * Get MCP servers that should be attached to a session
 *
 * @param sessionId - Session to get servers for
 * @param deps - Repository dependencies
 * @returns Array of MCP servers with source metadata
 *
 * @example
 * ```typescript
 * const servers = await getMcpServersForSession(sessionId, {
 *   sessionMCPRepo,
 *   mcpServerRepo
 * });
 *
 * // Always returns: ALL global MCPs + session-assigned MCPs (deduplicated)
 * // => [
 * //   { server: { name: "filesystem", scope: "global", ... }, source: "global" },
 * //   { server: { name: "preset sdx", scope: "session", ... }, source: "session-assigned" }
 * // ]
 * ```
 */
export async function getMcpServersForSession(
  sessionId: SessionID,
  deps: MCPResolutionDeps
): Promise<MCPServerWithSource[]> {
  const servers: MCPServerWithSource[] = [];

  // Early return if dependencies not available
  if (!deps.sessionMCPRepo || !deps.mcpServerRepo) {
    console.warn('⚠️  MCP repository dependencies not available - skipping MCP configuration');
    return servers;
  }

  try {
    console.log('🔌 Resolving MCP servers for session...');
    console.log(`   [MCP Scoping] forUserId: ${deps.forUserId || 'NOT SET'}`);

    // Track seen server IDs to prevent duplicates
    const seenServerIds = new Set<string>();

    const addServer = (server: MCPServer, source: MCPServerWithSource['source']) => {
      if (!seenServerIds.has(server.mcp_server_id)) {
        seenServerIds.add(server.mcp_server_id);
        servers.push({ server, source });
        return;
      }

      console.warn(
        `   ⚠️  Skipping duplicate ${source} MCP server: ${server.name} (${server.mcp_server_id})`
      );
    };

    if (typeof deps.sessionMCPRepo.listEffectiveServers === 'function') {
      const effectiveServers = await deps.sessionMCPRepo.listEffectiveServers(sessionId, true);
      console.log(`   📍 Effective session scope: ${effectiveServers.length} server(s)`);

      for (const server of effectiveServers) {
        addServer(server, server.scope === 'global' ? 'global' : 'session-assigned');
      }
    } else {
      // STEP 1: Get ALL global-scoped MCP servers (available to all sessions)
      // Pass forUserId for per-user OAuth token injection
      console.log(
        `   [MCP Scoping] Calling findAll with forUserId: ${deps.forUserId || 'NOT SET'}`
      );
      const globalServers = await deps.mcpServerRepo.findAll(
        {
          scope: 'global',
          enabled: true,
        },
        deps.forUserId
      );

      console.log(`   📍 Global scope: ${globalServers?.length ?? 0} server(s)`);

      for (const server of globalServers ?? []) {
        addServer(server, 'global');
      }

      // STEP 2: Get session-scoped MCP servers assigned to this specific session
      const sessionServers = await deps.sessionMCPRepo.listServers(sessionId, true); // enabledOnly

      console.log(`   📍 Session-assigned: ${sessionServers.length} server(s)`);

      for (const server of sessionServers) {
        addServer(server, 'session-assigned');
      }
    }

    // Log summary (before template resolution)
    if (servers.length > 0) {
      console.log(`   ✅ Total: ${servers.length} MCP server(s) resolved`);
      for (const { server, source } of servers) {
        console.log(`      - ${server.name} (${server.transport}) [${source}]`);
      }
    } else {
      console.log('   ℹ️  No MCP servers available for this session');
    }

    // STEP 3: Resolve templates in config fields (url, env.*, auth.*)
    // process.env contains user's decrypted env vars (set by createUserProcessEnvironment)
    // SECURITY: Only user-defined vars are exposed (via AGOR_USER_ENV_KEYS)
    const templateContext = buildMCPTemplateContextFromEnv(process.env);
    let templatesResolved = 0;
    let serversSkipped = 0;

    const containsTemplate = (v: string | undefined) => v?.includes('{{') && v?.includes('}}');

    // Process servers in reverse to safely remove invalid ones
    for (let i = servers.length - 1; i >= 0; i--) {
      const original = servers[i].server;

      // Check if any templatable field contains templates
      const envValues = Object.values(original.env ?? {}) as string[];
      const headerValues = Object.values(original.headers ?? {}) as string[];
      const hasEnvTemplates = envValues.some(containsTemplate);
      const hasHeaderTemplates = headerValues.some(containsTemplate);
      const hasUrlTemplate = containsTemplate(original.url);
      const hasAuthTemplates =
        containsTemplate(original.auth?.token) ||
        containsTemplate(original.auth?.api_url) ||
        containsTemplate(original.auth?.api_token) ||
        containsTemplate(original.auth?.api_secret);

      if (hasEnvTemplates || hasHeaderTemplates || hasUrlTemplate || hasAuthTemplates) {
        const result = resolveMcpServerTemplates(original, templateContext);

        if (!result.isValid) {
          // Remove server from list - required templates didn't resolve
          console.warn(`   ⚠️  Skipping MCP server "${original.name}": ${result.errorMessage}`);
          servers.splice(i, 1);
          serversSkipped++;
        } else {
          servers[i] = {
            ...servers[i],
            server: result.server,
          };
          templatesResolved++;

          // Log warnings for non-critical unresolved fields
          if (result.unresolvedFields.length > 0) {
            console.warn(
              `   ⚠️  MCP server "${original.name}" has unresolved optional templates: ${result.unresolvedFields.join(', ')}`
            );
          }
        }
      }
    }

    if (templatesResolved > 0) {
      console.log(`   🔧 Resolved templates in ${templatesResolved} MCP server(s)`);
    }
    if (serversSkipped > 0) {
      console.log(
        `   ⚠️  Skipped ${serversSkipped} MCP server(s) due to unresolved required templates`
      );
    }
  } catch (error) {
    console.error('❌ Failed to resolve MCP servers:', error);
    // Return empty array on error to avoid breaking session creation
    return [];
  }

  return servers;
}

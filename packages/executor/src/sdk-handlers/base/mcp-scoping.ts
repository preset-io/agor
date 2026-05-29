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

import { buildMCPTemplateContext, resolveMcpServerTemplates } from '@agor/core/mcp';
import type { MCPServer, SessionID } from '@agor/core/types';
import type {
  MCPServerRepository,
  SessionMCPServerRepository,
  SessionRepository,
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
   * Sessions repository — used to fetch the session row at resolution
   * time so its ``custom_context`` blob can populate the
   * ``session.custom_context.*`` template namespace. When absent (e.g.
   * call sites that don't care about session-scoped templates), only
   * ``user.env.*`` substitutions are available.
   */
  sessionRepo?: SessionRepository;
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

    // STEP 1: Get ALL global-scoped MCP servers (available to all sessions)
    // Pass forUserId for per-user OAuth token injection
    console.log(`   [MCP Scoping] Calling findAll with forUserId: ${deps.forUserId || 'NOT SET'}`);
    const globalServers = await deps.mcpServerRepo.findAll(
      {
        scope: 'global',
        enabled: true,
      },
      deps.forUserId
    );

    console.log(`   📍 Global scope: ${globalServers?.length ?? 0} server(s)`);

    for (const server of globalServers ?? []) {
      if (!seenServerIds.has(server.mcp_server_id)) {
        seenServerIds.add(server.mcp_server_id);
        servers.push({
          server,
          source: 'global',
        });
      } else {
        console.warn(
          `   ⚠️  Skipping duplicate global MCP server: ${server.name} (${server.mcp_server_id})`
        );
      }
    }

    // STEP 2: Get session-scoped MCP servers assigned to this specific session
    const sessionServers = await deps.sessionMCPRepo.listServers(sessionId, true); // enabledOnly

    console.log(`   📍 Session-assigned: ${sessionServers.length} server(s)`);

    for (const server of sessionServers) {
      if (!seenServerIds.has(server.mcp_server_id)) {
        seenServerIds.add(server.mcp_server_id);
        servers.push({
          server,
          source: 'session-assigned',
        });
      } else {
        console.warn(
          `   ⚠️  Skipping duplicate session-assigned MCP server: ${server.name} (${server.mcp_server_id})`
        );
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
    //
    // Two channels of caller-supplied values are exposed to templates:
    //
    // - ``user.env.*`` — drawn from process.env, filtered through
    //   AGOR_USER_ENV_KEYS so only user-defined vars are visible. The
    //   daemon's own secrets stay invisible. See
    //   ``createUserProcessEnvironment`` for how the env is populated.
    //
    // - ``session.custom_context.*`` — drawn from this session's row,
    //   stamped by the session creator at ``POST /sessions`` time. The
    //   agent has no MCP tool to write to its own session's
    //   ``custom_context``, so this is a one-way channel from creator
    //   to MCP config — useful for an embedding host that wants to
    //   forward a short-lived, per-session credential into
    //   ``auth.token`` without persisting it on the user record.
    let sessionCustomContext: Record<string, unknown> | null | undefined;
    if (deps.sessionRepo) {
      try {
        const sessionRow = await deps.sessionRepo.findById(sessionId);
        sessionCustomContext = (sessionRow?.custom_context ?? null) as Record<
          string,
          unknown
        > | null;
      } catch (error) {
        // Failure to load the session row is non-fatal — templates that
        // referenced ``session.custom_context.*`` simply resolve empty
        // and surface as "unresolved required template" errors on the
        // affected MCP server. Logged so operators can find it.
        console.warn(
          `   ⚠️  Failed to load session ${sessionId} for custom_context templates:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const templateContext = buildMCPTemplateContext({
      env: process.env,
      sessionCustomContext,
    });
    let templatesResolved = 0;
    let serversSkipped = 0;

    const containsTemplate = (v: string | undefined) => v?.includes('{{') && v?.includes('}}');

    // Process servers in reverse to safely remove invalid ones
    for (let i = servers.length - 1; i >= 0; i--) {
      const original = servers[i].server;

      // Check if any templatable field contains templates
      const envValues = Object.values(original.env ?? {}) as string[];
      const hasEnvTemplates = envValues.some(containsTemplate);
      const hasUrlTemplate = containsTemplate(original.url);
      const hasAuthTemplates =
        containsTemplate(original.auth?.token) ||
        containsTemplate(original.auth?.api_url) ||
        containsTemplate(original.auth?.api_token) ||
        containsTemplate(original.auth?.api_secret);

      if (hasEnvTemplates || hasUrlTemplate || hasAuthTemplates) {
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

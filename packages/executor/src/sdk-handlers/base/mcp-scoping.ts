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
 * Note: owner_user_id on MCP servers is NOT used for filtering. Global MCPs are
 * truly global and available to all sessions regardless of who created them.
 */

import type { MCPServer, SessionID } from '@agor/core/types';
import type {
  FeathersSessionsRepository,
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
  sessionsRepo?: FeathersSessionsRepository;
  sessionMCPRepo?: SessionMCPServerRepository;
  mcpServerRepo?: MCPServerRepository;
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
 *   sessionsRepo,
 *   sessionMCPRepo,
 *   mcpServerRepo
 * });
 *
 * // Always returns: ALL global MCPs + session-assigned MCPs
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
  if (!deps.sessionsRepo || !deps.sessionMCPRepo || !deps.mcpServerRepo) {
    console.warn('⚠️  MCP repository dependencies not available - skipping MCP configuration');
    return servers;
  }

  try {
    // Fetch session to get owner (created_by)
    const session = await deps.sessionsRepo.findById(sessionId);
    if (!session) {
      console.error(`❌ Session ${sessionId} not found`);
      return servers;
    }

    console.log('🔌 Resolving MCP servers for session...');

    // STEP 1: Get ALL global-scoped MCP servers (available to all sessions)
    const globalServers = await deps.mcpServerRepo.findAll({
      scope: 'global',
      enabled: true,
    });

    console.log(`   📍 Global scope: ${globalServers?.length ?? 0} server(s)`);

    for (const server of globalServers ?? []) {
      servers.push({
        server,
        source: 'global',
      });
    }

    // STEP 2: Get session-scoped MCP servers assigned to this specific session
    const sessionServers = await deps.sessionMCPRepo.listServers(sessionId, true); // enabledOnly

    console.log(`   📍 Session-assigned: ${sessionServers.length} server(s)`);

    for (const server of sessionServers) {
      servers.push({
        server,
        source: 'session-assigned',
      });
    }

    // Log summary
    if (servers.length > 0) {
      console.log(`   ✅ Total: ${servers.length} MCP server(s) resolved`);
      for (const { server, source } of servers) {
        console.log(`      - ${server.name} (${server.transport}) [${source}]`);
      }
    } else {
      console.log('   ℹ️  No MCP servers available for this session');
    }
  } catch (error) {
    console.error('❌ Failed to resolve MCP servers:', error);
    // Return empty array on error to avoid breaking session creation
    return [];
  }

  return servers;
}

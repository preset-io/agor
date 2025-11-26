/**
 * MCP Server Scoping Utility
 *
 * Shared logic for determining which MCP servers should be attached to a session.
 * Used by all SDK handlers (Claude, Gemini, Codex) to ensure consistent behavior.
 *
 * Scoping Rules:
 * - Isolated Mode: Session has assigned servers → use ONLY those
 * - Hierarchical Mode: Session has NO assigned servers → fall back to global servers
 */

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
 * // Isolated mode (session has assigned servers)
 * // => [{ server: { name: "mcp sdx", ... }, source: "session-assigned" }]
 *
 * // Hierarchical mode (session has no assigned servers)
 * // => [{ server: { name: "filesystem", ... }, source: "global" }, ...]
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
    // Check if session has explicitly assigned MCP servers (via junction table)
    const sessionServers = await deps.sessionMCPRepo.listServers(sessionId, true); // enabledOnly

    // Isolated Mode: Session has assigned MCP servers
    if (sessionServers.length > 0) {
      console.log('🔌 Using session-assigned MCP servers (isolated mode)...');
      console.log(`   📍 Session-assigned: ${sessionServers.length} server(s)`);

      for (const server of sessionServers) {
        servers.push({
          server,
          source: 'session-assigned',
        });
      }
    }
    // Hierarchical Mode: Session has no assigned servers, fall back to global
    else {
      console.log('🔌 Fetching global MCP servers (hierarchical mode)...');

      // Get all global servers for the current user
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

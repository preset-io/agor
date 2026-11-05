/**
 * Session-MCP Server Relationship Repository
 *
 * Manages the many-to-many relationship between sessions and MCP servers.
 */

import type {
  MCPServer,
  MCPServerID,
  Session,
  SessionID,
  SessionMCPServer,
} from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { isMCPServerUsableInSession, MCPServerNotUsableError } from '../../mcp/ownership';
import type { Database } from '../client';
import { deleteFrom, insert, runDatabaseTransaction, select, update } from '../database-wrapper';
import { type SessionMCPServerInsert, sessionMcpServers } from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';
import { MCPServerRepository } from './mcp-servers';
import { SessionRepository } from './sessions';

/**
 * Session-MCP Server repository implementation
 */
export class SessionMCPServerRepository {
  private sessionRepo: SessionRepository;
  private mcpServerRepo: MCPServerRepository;

  constructor(private db: Database) {
    this.sessionRepo = new SessionRepository(db);
    this.mcpServerRepo = new MCPServerRepository(db);
  }

  /**
   * Resolve a session/server pair, refusing one the session may not use.
   *
   * Every path that *links* a server to a session — route, session service,
   * scheduler, gateway, zone trigger, fork/spawn copy — ends up here, so the
   * ownership rule is enforced once rather than in each of them. It answers on
   * the session's creator, not the caller, because the caller is not always
   * the identity the session will run as.
   *
   * This is not the only seam ownership needs. Global-scope resolution never
   * touches the junction table, and OAuth credential issuance works from
   * server ids directly; both carry their own check.
   */
  private async resolveUsablePair(
    sessionId: SessionID,
    serverId: MCPServerID
  ): Promise<{ server: MCPServer; session: Session }> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new EntityNotFoundError('Session', sessionId);
    }

    const server = await this.mcpServerRepo.findById(serverId);
    if (!server) {
      throw new EntityNotFoundError('MCPServer', serverId);
    }

    if (!isMCPServerUsableInSession(server, session)) {
      throw new MCPServerNotUsableError(serverId, sessionId);
    }

    return { server, session };
  }

  /**
   * Add MCP server to session
   */
  async addServer(sessionId: SessionID, serverId: MCPServerID): Promise<void> {
    try {
      await this.resolveUsablePair(sessionId, serverId);

      // Insert-first instead of check-then-insert: the unique index is the
      // durable idempotency guard when two recovering daemons attach the same
      // server concurrently.
      const newRelationship: SessionMCPServerInsert = {
        session_id: sessionId,
        mcp_server_id: serverId,
        enabled: true,
        added_at: new Date(),
      };

      await insert(this.db, sessionMcpServers).values(newRelationship).onConflictDoNothing().run();
      await update(this.db, sessionMcpServers)
        .set({ enabled: true })
        .where(
          and(
            eq(sessionMcpServers.session_id, sessionId),
            eq(sessionMcpServers.mcp_server_id, serverId)
          )
        )
        .run();
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof MCPServerNotUsableError) throw error;
      throw new RepositoryError(
        `Failed to add MCP server to session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Remove MCP server from session
   */
  async removeServer(sessionId: SessionID, serverId: MCPServerID): Promise<void> {
    try {
      const result = await deleteFrom(this.db, sessionMcpServers)
        .where(
          and(
            eq(sessionMcpServers.session_id, sessionId),
            eq(sessionMcpServers.mcp_server_id, serverId)
          )
        )
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('SessionMCPServer', `${sessionId}/${serverId}`);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to remove MCP server from session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Toggle MCP server enabled state for session
   */
  async toggleServer(sessionId: SessionID, serverId: MCPServerID, enabled: boolean): Promise<void> {
    try {
      const result = await update(this.db, sessionMcpServers)
        .set({ enabled })
        .where(
          and(
            eq(sessionMcpServers.session_id, sessionId),
            eq(sessionMcpServers.mcp_server_id, serverId)
          )
        )
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('SessionMCPServer', `${sessionId}/${serverId}`);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to toggle MCP server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Switch a server on or off for one session, creating the link if needed.
   * A link with `enabled: false` on a global server is the per-session
   * opt-out (`mcp/effective-set.ts`). Switching a global server back on in a
   * session that inherits globals drops the opt-out instead of adding a
   * redundant link. Returns whether an enabled link exists afterwards.
   */
  async setServerEnabled(
    sessionId: SessionID,
    serverId: MCPServerID,
    enabled: boolean
  ): Promise<{ linked: boolean }> {
    try {
      const { server, session } = await this.resolveUsablePair(sessionId, serverId);
      const pair = and(
        eq(sessionMcpServers.session_id, sessionId),
        eq(sessionMcpServers.mcp_server_id, serverId)
      );
      if (enabled && server.scope === 'global' && !session.mcp_selection_explicit) {
        await deleteFrom(this.db, sessionMcpServers).where(pair).run();
        return { linked: false };
      }
      await insert(this.db, sessionMcpServers)
        .values({ session_id: sessionId, mcp_server_id: serverId, enabled, added_at: new Date() })
        .onConflictDoNothing()
        .run();
      await update(this.db, sessionMcpServers).set({ enabled }).where(pair).run();
      return { linked: enabled };
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof MCPServerNotUsableError) throw error;
      throw new RepositoryError(
        `Failed to switch MCP server for session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Every link of a session with its enabled flag, opt-outs included. */
  async listLinks(
    sessionId: SessionID
  ): Promise<Array<{ mcp_server_id: MCPServerID; enabled: boolean }>> {
    const rows = await select(this.db)
      .from(sessionMcpServers)
      .where(eq(sessionMcpServers.session_id, sessionId))
      .all();
    return rows.map((row: { mcp_server_id: string; enabled: unknown }) => ({
      mcp_server_id: row.mcp_server_id as MCPServerID,
      enabled: Boolean(row.enabled),
    }));
  }

  /**
   * List MCP servers for a session
   */
  async listServers(sessionId: SessionID, enabledOnly = false): Promise<MCPServer[]> {
    try {
      // Get all relationships for this session
      const conditions = [eq(sessionMcpServers.session_id, sessionId)];

      if (enabledOnly) {
        conditions.push(eq(sessionMcpServers.enabled, true));
      }

      const relationships = await select(this.db)
        .from(sessionMcpServers)
        .where(and(...conditions))
        .all();

      // Fetch full MCP server details for each relationship. Filter stale
      // rows as well as preventing new invalid attachments: old data may have
      // been created before ownership enforcement existed.
      const session = await this.sessionRepo.findById(sessionId);
      const servers: MCPServer[] = [];
      for (const rel of relationships) {
        const server = await this.mcpServerRepo.findById(rel.mcp_server_id);
        if (server && session && isMCPServerUsableInSession(server, session)) {
          servers.push(server);
        }
      }

      return servers;
    } catch (error) {
      throw new RepositoryError(
        `Failed to list MCP servers for session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * List MCP servers for a session with relationship metadata (added_at timestamp)
   * Used to detect if servers were added after session creation
   */
  async listServersWithMetadata(
    sessionId: SessionID,
    enabledOnly = false
  ): Promise<Array<{ server: MCPServer; added_at: number; enabled: boolean }>> {
    try {
      // Get all relationships for this session
      const conditions = [eq(sessionMcpServers.session_id, sessionId)];

      if (enabledOnly) {
        conditions.push(eq(sessionMcpServers.enabled, true));
      }

      const relationships = await select(this.db)
        .from(sessionMcpServers)
        .where(and(...conditions))
        .all();

      // Fetch full MCP server details with metadata for each relationship
      const session = await this.sessionRepo.findById(sessionId);
      const results: Array<{ server: MCPServer; added_at: number; enabled: boolean }> = [];
      for (const rel of relationships) {
        const server = await this.mcpServerRepo.findById(rel.mcp_server_id);
        if (server && session && isMCPServerUsableInSession(server, session)) {
          results.push({
            server,
            added_at: new Date(rel.added_at).getTime(), // Convert to timestamp
            enabled: Boolean(rel.enabled),
          });
        }
      }

      return results;
    } catch (error) {
      throw new RepositoryError(
        `Failed to list MCP servers with metadata for session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Set MCP servers for a session (bulk operation)
   * Replaces the enabled links. Per-session opt-outs of global servers
   * (disabled links) are kept unless `disabledServerIds` replaces them too.
   */
  async setServers(
    sessionId: SessionID,
    serverIds: MCPServerID[],
    options: { markSelectionExplicit?: boolean; disabledServerIds?: MCPServerID[] } = {}
  ): Promise<void> {
    try {
      // Treat the replacement as a set at the repository boundary as well as
      // in the MCP tool. This protects callers that use the repository/service
      // directly from duplicate-key failures during the atomic insert.
      const uniqueServerIds = [...new Set(serverIds)];
      const enabledIds = new Set(uniqueServerIds);
      const keptOptOuts = async () => {
        const ids: MCPServerID[] = [];
        for (const link of await this.listLinks(sessionId)) {
          if (link.enabled) continue;
          const server = await this.mcpServerRepo.findById(link.mcp_server_id);
          if (server?.scope === 'global') ids.push(link.mcp_server_id);
        }
        return ids;
      };
      const disabledIds = [...new Set(options.disabledServerIds ?? (await keptOptOuts()))].filter(
        (serverId) => !enabledIds.has(serverId)
      );

      // Validate the complete replacement before deleting anything, so one
      // private/foreign server cannot partially alter the existing set.
      for (const serverId of uniqueServerIds) {
        await this.resolveUsablePair(sessionId, serverId);
      }
      for (const serverId of options.disabledServerIds ? disabledIds : []) {
        await this.resolveUsablePair(sessionId, serverId);
      }

      if (uniqueServerIds.length === 0) {
        const session = await this.sessionRepo.findById(sessionId);
        if (!session) {
          throw new EntityNotFoundError('Session', sessionId);
        }
      }

      // Delete + insert must be one database transaction. Validation above is
      // intentionally outside the transaction (it only reads), while the
      // replacement itself must never expose a partially applied set if an
      // insert, foreign-key check, or concurrent writer fails.
      await runDatabaseTransaction(
        this.db,
        async (tx) => {
          // Creation-time selections persist the distinction even when no links
          // are inserted; the marker and links commit or roll back together.
          // A plain link replacement leaves implicit global servers alone.
          if (options.markSelectionExplicit) {
            await new SessionRepository(tx).update(sessionId, { mcp_selection_explicit: true });
          }
          await deleteFrom(tx, sessionMcpServers)
            .where(eq(sessionMcpServers.session_id, sessionId))
            .run();

          if (uniqueServerIds.length > 0 || disabledIds.length > 0) {
            const inserts: SessionMCPServerInsert[] = [
              ...uniqueServerIds.map((serverId) => ({ serverId, enabled: true })),
              ...disabledIds.map((serverId) => ({ serverId, enabled: false })),
            ].map(({ serverId, enabled }) => ({
              session_id: sessionId,
              mcp_server_id: serverId,
              enabled,
              added_at: new Date(),
            }));

            await insert(tx, sessionMcpServers).values(inserts).run();
          }
        },
        { sqliteImmediate: true }
      );
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      if (error instanceof MCPServerNotUsableError) throw error;
      throw new RepositoryError(
        `Failed to set MCP servers for session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Get relationship details
   */
  async getRelationship(
    sessionId: SessionID,
    serverId: MCPServerID
  ): Promise<SessionMCPServer | null> {
    try {
      const row = await select(this.db)
        .from(sessionMcpServers)
        .where(
          and(
            eq(sessionMcpServers.session_id, sessionId),
            eq(sessionMcpServers.mcp_server_id, serverId)
          )
        )
        .one();

      if (!row) {
        return null;
      }

      return {
        session_id: row.session_id as SessionID,
        mcp_server_id: row.mcp_server_id as MCPServerID,
        enabled: Boolean(row.enabled),
        added_at: new Date(row.added_at),
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to get relationship: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count MCP servers for a session
   */
  async count(sessionId: SessionID, enabledOnly = false): Promise<number> {
    try {
      const servers = await this.listServers(sessionId, enabledOnly);
      return servers.length;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

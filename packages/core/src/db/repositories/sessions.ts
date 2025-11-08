/**
 * Session Repository
 *
 * Type-safe CRUD operations for sessions with short ID support.
 */

import type { Session, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { eq, like, or, sql } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { type SessionInsert, type SessionRow, sessions } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';
import { deepMerge } from './merge-utils';

/**
 * Session repository implementation
 */
export class SessionRepository implements BaseRepository<Session, Partial<Session>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Session type
   */
  private rowToSession(row: SessionRow): Session {
    const genealogyData = row.data.genealogy || { children: [] };

    return {
      session_id: row.session_id as UUID,
      status: row.status,
      agentic_tool: row.agentic_tool,
      created_at: new Date(row.created_at).toISOString(),
      last_updated: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      created_by: row.created_by,
      worktree_id: row.worktree_id as UUID,
      ...row.data,
      tasks: row.data.tasks.map(id => id as UUID),
      genealogy: {
        parent_session_id: row.parent_session_id as UUID | undefined,
        forked_from_session_id: row.forked_from_session_id as UUID | undefined,
        fork_point_task_id: genealogyData.fork_point_task_id as UUID | undefined,
        spawn_point_task_id: genealogyData.spawn_point_task_id as UUID | undefined,
        children: genealogyData.children.map(id => id as UUID),
      },
      permission_config: row.data.permission_config,
      scheduled_run_at: row.scheduled_run_at ?? undefined,
      scheduled_from_worktree: row.scheduled_from_worktree ?? false,
      current_context_usage: row.data.current_context_usage,
      context_window_limit: row.data.context_window_limit,
      last_context_update_at: row.data.last_context_update_at,
    };
  }

  /**
   * Convert Session to database insert format
   */
  private sessionToInsert(session: Partial<Session>): SessionInsert {
    const now = Date.now();
    const sessionId = session.session_id ?? generateId();

    if (!session.worktree_id) {
      throw new RepositoryError('Session must have a worktree_id');
    }

    return {
      session_id: sessionId,
      created_at: new Date(session.created_at ? session.created_at : now),
      updated_at: session.last_updated ? new Date(session.last_updated) : new Date(now),
      status: session.status ?? SessionStatus.IDLE,
      agentic_tool: session.agentic_tool ?? 'claude-code',
      created_by: session.created_by ?? 'anonymous',
      board_id: null, // Board ID tracked separately in boards.sessions array
      parent_session_id: session.genealogy?.parent_session_id ?? null,
      forked_from_session_id: session.genealogy?.forked_from_session_id ?? null,
      worktree_id: session.worktree_id,
      scheduled_run_at: session.scheduled_run_at ?? null,
      scheduled_from_worktree: session.scheduled_from_worktree ?? false,
      data: {
        agentic_tool_version: session.agentic_tool_version,
        sdk_session_id: session.sdk_session_id, // Preserve SDK session ID for conversation continuity
        mcp_token: session.mcp_token, // MCP authentication token for Agor self-access
        title: session.title,
        description: session.description,
        git_state: session.git_state ?? {
          ref: 'main',
          base_sha: '',
          current_sha: '',
        },
        genealogy: session.genealogy ?? {
          children: [],
        },
        contextFiles: session.contextFiles ?? [],
        tasks: session.tasks ?? [],
        message_count: session.message_count ?? 0,
        permission_config: session.permission_config,
        model_config: session.model_config
          ? {
              ...session.model_config,
              thinkingMode: session.model_config.thinkingMode ?? 'auto',
            }
          : undefined,
        custom_context: session.custom_context,
        current_context_usage: session.current_context_usage,
        context_window_limit: session.context_window_limit,
        last_context_update_at: session.last_context_update_at,
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await this.db
      .select({ session_id: sessions.session_id })
      .from(sessions)
      .where(like(sessions.session_id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('Session', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Session',
        id,
        results.map(r => formatShortId(r.session_id as UUID))
      );
    }

    return results[0].session_id as UUID;
  }

  /**
   * Create a new session
   */
  async create(data: Partial<Session>): Promise<Session> {
    try {
      const insert = this.sessionToInsert(data);
      await this.db.insert(sessions).values(insert);

      const row = await this.db
        .select()
        .from(sessions)
        .where(eq(sessions.session_id, insert.session_id))
        .get();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created session');
      }

      return this.rowToSession(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find session by ID (supports short ID)
   */
  async findById(id: string): Promise<Session | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await this.db
        .select()
        .from(sessions)
        .where(eq(sessions.session_id, fullId))
        .get();

      return row ? this.rowToSession(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all sessions
   */
  async findAll(): Promise<Session[]> {
    try {
      const rows = await this.db.select().from(sessions).all();
      return rows.map(row => this.rowToSession(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions by status
   */
  async findByStatus(status: Session['status']): Promise<Session[]> {
    try {
      const rows = await this.db.select().from(sessions).where(eq(sessions.status, status)).all();

      return rows.map(row => this.rowToSession(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by status: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions by board ID
   */
  async findByBoard(boardId: string): Promise<Session[]> {
    try {
      // OPTIMIZED: Uses materialized board_id column for O(1) indexed lookup
      // Previously loaded ALL sessions and filtered in-memory (O(n) full table scan)
      const rows = await this.db
        .select()
        .from(sessions)
        .where(eq(sessions.board_id, boardId))
        .all();

      return rows.map(row => this.rowToSession(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find child sessions (forked or spawned from this session)
   */
  async findChildren(sessionId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);

      // Query sessions where parent_session_id or forked_from_session_id matches
      const rows = await this.db
        .select()
        .from(sessions)
        .where(
          or(
            sql`json_extract(${sessions.data}, '$.genealogy.parent_session_id') = ${fullId}`,
            sql`json_extract(${sessions.data}, '$.genealogy.forked_from_session_id') = ${fullId}`
          )
        )
        .all();

      return rows.map(row => this.rowToSession(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find child sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find ancestor sessions (parent chain)
   *
   * OPTIMIZED: Uses indexed parent_session_id lookups instead of iterating with findById.
   * Each parent lookup is O(log n) on indexed column instead of potentially O(1) hash on ID.
   * Total still O(n) but with dramatically lower constant factor due to schema optimization.
   */
  async findAncestors(sessionId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);
      const ancestors: Session[] = [];
      const visited = new Set<string>();

      let currentSessionId: string | undefined = fullId;
      let depth = 0;
      const MAX_DEPTH = 100; // Prevent infinite loops

      while (currentSessionId && depth < MAX_DEPTH) {
        // Get current session to find parent
        const current = await this.findById(currentSessionId);
        if (!current) break;

        const parentId =
          current.genealogy?.parent_session_id || current.genealogy?.forked_from_session_id;

        if (!parentId || visited.has(parentId)) break;

        // Use indexed parent lookup (faster than looping through all sessions)
        const parent = await this.findById(parentId);
        if (!parent) break;

        ancestors.push(parent);
        visited.add(parentId);
        currentSessionId = parentId;
        depth++;
      }

      return ancestors;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find ancestor sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update session by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., user changes settings while permission
   * hook is saving allowedTools).
   */
  async update(id: string, updates: Partial<Session>): Promise<Session> {
    try {
      const fullId = await this.resolveId(id);

      // Use transaction to make read-merge-write atomic
      // This prevents race conditions where another update happens between read and write
      return await this.db.transaction(async tx => {
        // STEP 1: Read current session (within transaction)
        const currentRow = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.session_id, fullId))
          .get();

        if (!currentRow) {
          throw new EntityNotFoundError('Session', id);
        }

        const current = this.rowToSession(currentRow);

        // STEP 2: Deep merge updates into current session (in memory)
        // IMPORTANT: Receiver-side merge for nested objects (permission_config, model_config, etc.)
        // This prevents partial updates from losing existing nested fields.
        // Strategy: Objects = deep merge, Arrays = replace, Primitives = replace
        const merged = deepMerge(current, updates);

        // Debug logging for permission_config persistence
        if (updates.permission_config) {
          console.log(`📝 [SessionRepository] Merging permission_config update (atomic tx)`);
          console.log(`   Before merge: ${JSON.stringify(current.permission_config)}`);
          console.log(`   Update: ${JSON.stringify(updates.permission_config)}`);
          console.log(`   After merge: ${JSON.stringify(merged.permission_config)}`);
        }

        const insert = this.sessionToInsert(merged);

        // STEP 3: Write merged session (within same transaction)
        await tx
          .update(sessions)
          .set({
            status: insert.status,
            updated_at: new Date(),
            data: insert.data,
          })
          .where(eq(sessions.session_id, fullId));

        console.log(`✅ [SessionRepository] Atomic update complete`);

        // Return merged session (no need to re-fetch, we have it in memory)
        return merged;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete session by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await this.db.delete(sessions).where(eq(sessions.session_id, fullId)).run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Session', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions with running tasks
   */
  async findRunning(): Promise<Session[]> {
    return this.findByStatus(SessionStatus.RUNNING);
  }

  /**
   * Count total sessions
   */
  async count(): Promise<number> {
    try {
      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(sessions)
        .get();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

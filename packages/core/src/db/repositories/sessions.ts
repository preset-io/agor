/**
 * Session Repository
 *
 * Type-safe CRUD operations for sessions with short ID support.
 */

import type { Session, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { and, desc, eq, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { getBaseUrl } from '../../config/config-manager';
import { formatShortId, generateId } from '../../lib/ids';
import { getSessionUrl } from '../../utils/url';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  boards,
  type SessionInsert,
  type SessionRow,
  sessions,
  worktreeOwners,
  worktrees,
} from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';
import { deepMerge } from './merge-utils';

/**
 * Session with enriched last message
 */
export interface SessionWithLastMessage extends Session {
  last_message?: string;
}

/**
 * Session repository implementation
 */
export class SessionRepository implements BaseRepository<Session, Partial<Session>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Session type
   *
   * @param row - Database row
   * @param worktreeBoardId - Board ID from worktree (if JOINed)
   * @param boardSlug - Board slug from boards table (if JOINed)
   * @param baseUrl - Base URL for generating session URLs
   */
  private rowToSession(
    row: SessionRow,
    worktreeBoardId?: UUID | null,
    boardSlug?: string | null,
    baseUrl?: string
  ): Session {
    const genealogyData = row.data.genealogy || { children: [] };
    const sessionId = row.session_id as UUID;
    const boardId = worktreeBoardId ?? null;

    // Compute URL if baseUrl provided, otherwise null
    const url = baseUrl ? getSessionUrl(sessionId, boardId, boardSlug, baseUrl) : null;

    return {
      session_id: sessionId,
      status: row.status,
      agentic_tool: row.agentic_tool,
      created_at: new Date(row.created_at).toISOString(),
      last_updated: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      created_by: row.created_by,
      unix_username: row.unix_username || null,
      worktree_id: row.worktree_id as UUID,
      worktree_board_id: boardId,
      url,
      ...row.data,
      tasks: row.data.tasks.map((id) => id as UUID),
      genealogy: {
        parent_session_id: row.parent_session_id as UUID | undefined,
        forked_from_session_id: row.forked_from_session_id as UUID | undefined,
        fork_point_task_id: genealogyData.fork_point_task_id as UUID | undefined,
        fork_point_message_index: genealogyData.fork_point_message_index,
        spawn_point_task_id: genealogyData.spawn_point_task_id as UUID | undefined,
        spawn_point_message_index: genealogyData.spawn_point_message_index,
        children: genealogyData.children.map((id) => id as UUID),
      },
      permission_config: row.data.permission_config,
      scheduled_run_at: row.scheduled_run_at ?? undefined,
      scheduled_from_worktree: row.scheduled_from_worktree ?? false,
      ready_for_prompt: row.ready_for_prompt ?? false,
      archived: Boolean(row.archived), // Convert SQLite integer (0/1) to boolean
      archived_reason: row.archived_reason ?? undefined,
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
      unix_username: session.unix_username ?? null, // Stamped at creation time by setSessionUnixUsername hook
      board_id: null, // Board ID tracked separately in boards.sessions array
      parent_session_id: session.genealogy?.parent_session_id ?? null,
      forked_from_session_id: session.genealogy?.forked_from_session_id ?? null,
      worktree_id: session.worktree_id,
      scheduled_run_at: session.scheduled_run_at ?? null,
      scheduled_from_worktree: session.scheduled_from_worktree ?? false,
      ready_for_prompt: session.ready_for_prompt ?? false,
      archived: session.archived ?? false, // Default false for new sessions
      archived_reason: session.archived_reason ?? null,
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

    const results = await select(this.db)
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
        results.map((r: { session_id: string }) => formatShortId(r.session_id as UUID))
      );
    }

    return results[0].session_id as UUID;
  }

  /**
   * Create a new session
   */
  async create(data: Partial<Session>): Promise<Session> {
    try {
      const insertData = this.sessionToInsert(data);
      await insert(this.db, sessions).values(insertData).run();

      const baseUrl = await getBaseUrl();

      // LEFT JOIN with worktrees and boards to get board_id and slug
      const result = await select(this.db)
        .from(sessions)
        .leftJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
        .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
        .where(eq(sessions.session_id, insertData.session_id))
        .one();

      if (!result) {
        throw new RepositoryError('Failed to retrieve created session');
      }

      const sessionRow = result.sessions;
      const boardId = (result.worktrees?.board_id ?? null) as UUID | null;
      const boardSlug = result.boards?.slug ?? null;

      return this.rowToSession(sessionRow, boardId, boardSlug, baseUrl);
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
   *
   * Automatically LEFT JOINs with worktrees table to populate worktree_board_id and url.
   * This avoids N+1 queries when URL generation is needed.
   */
  async findById(id: string): Promise<Session | null> {
    try {
      const fullId = await this.resolveId(id);
      const baseUrl = await getBaseUrl();

      // LEFT JOIN with worktrees and boards to get board_id and slug in a single query
      const result = await select(this.db)
        .from(sessions)
        .leftJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
        .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
        .where(eq(sessions.session_id, fullId))
        .one();

      if (!result) {
        return null;
      }

      // Extract session row, board_id, and slug from JOIN result
      const sessionRow = result.sessions;
      const boardId = (result.worktrees?.board_id ?? null) as UUID | null;
      const boardSlug = result.boards?.slug ?? null;

      return this.rowToSession(sessionRow, boardId, boardSlug, baseUrl);
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
   *
   * LEFT JOINs with worktrees to populate board_id and url in a single query.
   */
  async findAll(): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();

      const results = await select(this.db)
        .from(sessions)
        .leftJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
        .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
        .all();

      return results.map(
        (result: {
          sessions: SessionRow;
          worktrees?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          const boardId = (result.worktrees?.board_id ?? null) as UUID | null;
          const boardSlug = result.boards?.slug ?? null;
          return this.rowToSession(sessionRow, boardId, boardSlug, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions by status
   *
   * LEFT JOINs with worktrees to populate board_id and url.
   */
  async findByStatus(status: Session['status']): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();

      const results = await select(this.db)
        .from(sessions)
        .leftJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
        .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
        .where(eq(sessions.status, status))
        .all();

      return results.map(
        (result: {
          sessions: SessionRow;
          worktrees?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          const boardId = (result.worktrees?.board_id ?? null) as UUID | null;
          const boardSlug = result.boards?.slug ?? null;
          return this.rowToSession(sessionRow, boardId, boardSlug, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by status: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions by board ID
   *
   * Uses materialized board_id column for O(1) indexed lookup.
   * LEFT JOINs with worktrees to populate url (board_id already known from filter).
   */
  async findByBoard(boardId: string): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();

      // Use materialized board_id column for indexed lookup
      const results = await select(this.db)
        .from(sessions)
        .leftJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
        .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
        .where(eq(sessions.board_id, boardId))
        .all();

      return results.map(
        (result: {
          sessions: SessionRow;
          worktrees?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          // We know board_id from the filter, but still get it from JOIN for consistency
          const board_id = (result.worktrees?.board_id ?? null) as UUID | null;
          const boardSlug = result.boards?.slug ?? null;
          return this.rowToSession(sessionRow, board_id, boardSlug, baseUrl);
        }
      );
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find child sessions (forked or spawned from this session)
   *
   * LEFT JOINs with worktrees to populate board_id and url.
   */
  async findChildren(sessionId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);
      const baseUrl = await getBaseUrl();

      // Query sessions where parent_session_id or forked_from_session_id matches
      // Use database-agnostic JSON extraction helper
      const { jsonExtract } = await import('../database-wrapper');

      const results = await select(this.db)
        .from(sessions)
        .leftJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
        .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
        .where(
          or(
            sql`${jsonExtract(this.db, sessions.data, 'genealogy.parent_session_id')} = ${fullId}`,
            sql`${jsonExtract(this.db, sessions.data, 'genealogy.forked_from_session_id')} = ${fullId}`
          )
        )
        .all();

      return results.map(
        (result: {
          sessions: SessionRow;
          worktrees?: { board_id?: string } | null;
          boards?: { slug?: string | null } | null;
        }) => {
          const sessionRow = result.sessions;
          const boardId = (result.worktrees?.board_id ?? null) as UUID | null;
          const boardSlug = result.boards?.slug ?? null;
          return this.rowToSession(sessionRow, boardId, boardSlug, baseUrl);
        }
      );
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
      const baseUrl = await getBaseUrl();

      const statusInfo = updates.status
        ? ` (status: ${updates.status}, ready_for_prompt: ${updates.ready_for_prompt})`
        : '';
      console.debug(`🔄 [SessionRepo] Updating session ${fullId.substring(0, 8)}${statusInfo}`);

      // Use transaction to make read-merge-write atomic
      // This prevents race conditions where another update happens between read and write
      const result = await this.db.transaction(async (tx) => {
        // STEP 1: Read current session with worktree and board JOINs (within transaction)
        // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
        const currentResult = await select(tx as any)
          .from(sessions)
          .leftJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
          .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
          .where(eq(sessions.session_id, fullId))
          .one();

        if (!currentResult) {
          throw new EntityNotFoundError('Session', id);
        }

        const currentRow = currentResult.sessions;
        const boardId = (currentResult.worktrees?.board_id ?? null) as UUID | null;
        const boardSlug = currentResult.boards?.slug ?? null;
        const current = this.rowToSession(currentRow, boardId, boardSlug, baseUrl);

        // STEP 2: Deep merge updates into current session (in memory)
        // IMPORTANT: Receiver-side merge for nested objects (permission_config, model_config, etc.)
        // This prevents partial updates from losing existing nested fields.
        // Strategy: Objects = deep merge, Arrays = replace, Primitives = replace
        const merged = deepMerge(current, updates);

        const insertData = this.sessionToInsert(merged);

        // STEP 3: Write merged session (within same transaction)
        // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
        await update(tx as any, sessions)
          .set({
            status: insertData.status,
            updated_at: new Date(),
            ready_for_prompt: insertData.ready_for_prompt,
            data: insertData.data,
          })
          .where(eq(sessions.session_id, fullId))
          .run();

        // Return merged session (no need to re-fetch, we have it in memory)
        return merged;
      });

      return result;
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

      const result = await deleteFrom(this.db, sessions)
        .where(eq(sessions.session_id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Session', id);
      }
    } catch (error) {
      console.error(`❌ [SessionRepo] Failed to delete session ${id}:`, error);
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
      const result = await select(this.db, { count: sql<number>`count(*)` }).from(sessions).one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all sessions in worktrees accessible to a user (optimized RBAC query)
   *
   * Uses INNER JOIN + LEFT JOIN to filter sessions by worktree access in one query
   * instead of N+1. Returns sessions where user is a worktree owner OR worktree.others_can
   * allows at least 'view' access.
   *
   * Also populates board_id and url via the worktrees JOIN.
   *
   * NOTE: This method should only be called when RBAC is enabled. When RBAC is disabled,
   * the scopeSessionQuery hook is not registered, so default Feathers query is used
   * (which returns all sessions without filtering).
   *
   * @param userId - User ID to check access for
   * @returns Array of accessible sessions with urls populated
   */
  async findAccessibleSessions(userId: UUID): Promise<Session[]> {
    const baseUrl = await getBaseUrl();

    // Get both session columns AND worktree board_id and board slug
    const results = await select(this.db)
      .from(sessions)
      .innerJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
      .leftJoin(boards, eq(worktrees.board_id, boards.board_id))
      .leftJoin(
        worktreeOwners,
        and(
          eq(worktreeOwners.worktree_id, worktrees.worktree_id),
          eq(worktreeOwners.user_id, userId)
        )
      )
      .where(
        or(
          isNotNull(worktreeOwners.user_id),
          inArray(worktrees.others_can, ['view', 'prompt', 'all'])
        )
      )
      .all();

    return results.map(
      (result: {
        sessions: SessionRow;
        worktrees?: { board_id?: string } | null;
        boards?: { slug?: string | null } | null;
      }) => {
        const sessionRow = result.sessions;
        const boardId = (result.worktrees?.board_id ?? null) as UUID | null;
        const boardSlug = result.boards?.slug ?? null;
        return this.rowToSession(sessionRow, boardId, boardSlug, baseUrl);
      }
    );
  }

  /**
   * Enrich a single session with last assistant message
   *
   * @param session - Session to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Session with last_message added
   */
  async enrichWithLastMessage(
    session: Session,
    truncationLength = 500
  ): Promise<SessionWithLastMessage> {
    const enriched = await this.enrichManyWithLastMessage([session], truncationLength);
    return enriched[0] || session;
  }

  /**
   * Enrich multiple sessions with last assistant message (batch operation)
   *
   * Fetches the most recent assistant message for each session.
   *
   * @param sessions - Array of sessions to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Array of sessions with last_message added
   */
  async enrichManyWithLastMessage(
    sessions: Session[],
    truncationLength = 500
  ): Promise<SessionWithLastMessage[]> {
    // Quick path: if no sessions, return empty array
    if (sessions.length === 0) {
      return [];
    }

    try {
      const sessionIds = sessions.map((s) => s.session_id);

      // Import messages table dynamically
      const { messages: messagesTable } = await import('../schema');

      // Get last assistant message for each session using N+1 queries
      // This is acceptable since we're enriching a small number of sessions at a time
      // Much better than fetching all messages which could be huge for long-running sessions
      const lastMessageBySession = new Map<string, string>();

      for (const sessionId of sessionIds) {
        const query = select(this.db, {
          data: messagesTable.data,
        })
          .from(messagesTable)
          .where(
            and(
              eq(messagesTable.session_id, sessionId),
              eq(messagesTable.role, 'assistant'),
              isNull(messagesTable.status) // Exclude queued messages
            )
          );

        // Chain orderBy and limit, then execute with one()
        // The spread operator in the wrapper passes through these methods
        // biome-ignore lint/suspicious/noExplicitAny: Wrapper spreads query builder methods
        const lastMessage = await (query as any).orderBy(desc(messagesTable.index)).limit(1).one();

        if (lastMessage) {
          // Extract text content from message data and truncate to requested length
          const messageData = lastMessage.data as {
            content?: Array<{ type: string; text?: string }>;
          };
          let fullText = '';

          // Extract text from content blocks (messages can have multiple content blocks)
          if (messageData?.content && Array.isArray(messageData.content)) {
            fullText = messageData.content
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('\n');
          }

          // Truncate to requested length
          if (fullText.length > truncationLength) {
            fullText = `${fullText.substring(0, truncationLength)}...`;
          }

          lastMessageBySession.set(sessionId, fullText);
        }
      }

      // Enrich sessions with last message
      return sessions.map((session) => {
        const lastMessage = lastMessageBySession.get(session.session_id) || '';
        return {
          ...session,
          last_message: lastMessage,
        };
      });
    } catch (error) {
      console.warn(
        'Failed to enrich sessions with last message:',
        error instanceof Error ? error.message : String(error)
      );
      // Return sessions without last message on error
      return sessions.map((session) => ({ ...session, last_message: '' }));
    }
  }
}
